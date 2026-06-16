import { marked, type Tokens } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js/lib/core";
import type { LanguageFn } from "highlight.js";
// `plaintext` is the universal fallback for not-yet-loaded / unknown languages
// AND for fences with no info string. It is NOT bundled in highlight.js/lib/
// core, and it's a 300-byte no-op grammar, so we register it eagerly (rather
// than lazily) — every fenced block needs SOME registered language to escape
// against, and lazy-loading the fallback would race the very first render.
import plaintext from "highlight.js/lib/languages/plaintext";
import createDOMPurify from "dompurify";
// KaTeX (the ~260 KB typesetter + its ~270 KB of bundled fonts/CSS) is loaded
// LAZILY — see the "Lazy KaTeX" section below. A static `import katex from
// "katex"` here would drag the whole library + stylesheet into the synchronous
// markdown chunk that loads the moment a chat view mounts, even for the common
// reply that contains no math at all. We instead dynamic-`import()` katex (and
// its stylesheet) the FIRST time a message actually contains a `$…$` / `$$…$$`
// formula, mirroring the lazy highlight.js grammar plumbing further down.

// Use a DEDICATED DOMPurify instance bound to the current window, instead of
// mutating the library's default singleton. The `addHook` we register below
// rewrites `<a href>` and gates `<img src>` data URIs — those rules are
// app-specific and must NOT leak into any other potential DOMPurify consumer
// (third-party libs, dev tooling) that imports the default. Creating an
// isolated instance with `createDOMPurify(window)` keeps our hooks scoped to
// this module's sanitize call only. On non-browser environments (tests under
// jsdom still expose `window`) the factory works the same; we keep the
// `typeof document === "undefined"` SSR guard in `renderMarkdown` for safety.
const DOMPurify =
  typeof window !== "undefined" ? createDOMPurify(window) : createDOMPurify;

/* ── Lazy highlight.js grammar registration (perf) ──────────────────────── */
//
// We used to STATICALLY import ~18 grammar modules at module top, dragging
// every one of them into the synchronous `highlight` chunk that loads the
// moment a chat view mounts — even for a session that never shows a single
// fenced code block, or only ever shows `ts`. Each grammar is its own async
// chunk now (via `import.meta.glob` with `eager:false`), so the boot graph
// ships only highlight.js core; a grammar's bytes arrive the FIRST time a code
// block actually uses that language.
//
// The wrinkle: `renderMarkdown` (and `marked-highlight`'s `highlight`
// callback) are SYNCHRONOUS, but dynamic `import()` is async. So the first
// render of a not-yet-loaded language falls back to a plaintext highlight
// (still tagged `language-<lang>` by `langPrefix`, so the label/copy chrome
// and tests are unaffected) and kicks off the async grammar load. When the
// grammar lands we register it, drop any memoized HTML that was rendered
// against the plaintext fallback, and notify subscribers so the chat view can
// re-render the now-highlightable blocks. Unknown / unsupported languages stay
// permanently on the plaintext fallback — exactly hljs's own behavior.

// Canonical grammar name → its lazy module loader. Each dynamic `import()` of a
// `highlight.js/lib/languages/*` subpath is code-split by Rollup/Vite into its
// own async chunk, so NONE of these grammars ship in the boot graph — a
// grammar's bytes are fetched only the first time a code block uses it. (We use
// an explicit map rather than `import.meta.glob` so the bundler sees concrete
// bare-specifier imports and we never glob across the node_modules boundary.)
type GrammarLoader = () => Promise<{ default: LanguageFn }>;
const loaderByName = new Map<string, GrammarLoader>([
  ["javascript", () => import("highlight.js/lib/languages/javascript")],
  ["typescript", () => import("highlight.js/lib/languages/typescript")],
  ["python", () => import("highlight.js/lib/languages/python")],
  ["rust", () => import("highlight.js/lib/languages/rust")],
  ["bash", () => import("highlight.js/lib/languages/bash")],
  ["shell", () => import("highlight.js/lib/languages/shell")],
  ["json", () => import("highlight.js/lib/languages/json")],
  ["css", () => import("highlight.js/lib/languages/css")],
  ["xml", () => import("highlight.js/lib/languages/xml")],
  ["sql", () => import("highlight.js/lib/languages/sql")],
  ["yaml", () => import("highlight.js/lib/languages/yaml")],
  ["markdown", () => import("highlight.js/lib/languages/markdown")],
  ["go", () => import("highlight.js/lib/languages/go")],
  ["java", () => import("highlight.js/lib/languages/java")],
  ["csharp", () => import("highlight.js/lib/languages/csharp")],
  ["cpp", () => import("highlight.js/lib/languages/cpp")],
  ["dockerfile", () => import("highlight.js/lib/languages/dockerfile")],
  ["diff", () => import("highlight.js/lib/languages/diff")],
]);

// Alias → canonical grammar name. Mirrors the old explicit registerLanguage
// alias calls (js→javascript, html→xml, sh/zsh→bash, …). Anything not listed
// is assumed to already BE a canonical grammar name (e.g. "python", "rust").
const GRAMMAR_ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  rs: "rust",
  sh: "bash",
  zsh: "bash",
  html: "xml",
  yml: "yaml",
  md: "markdown",
  cs: "csharp",
  c: "cpp",
};

function canonicalGrammar(lang: string): string {
  return GRAMMAR_ALIASES[lang] ?? lang;
}

// Names we've already kicked off (or completed) a load for — so a code-heavy
// reply doesn't fire N concurrent imports of the same grammar.
const grammarLoadStarted = new Set<string>();

// Re-render subscribers. When a lazily-loaded asset finishes (a highlight.js
// grammar OR — see the Lazy KaTeX section below — the KaTeX typesetter) we bump
// a version and notify, letting the chat view (MessageList) invalidate its
// markdown memo and re-render so the previously-fallback block (plaintext code /
// raw-TeX math) renders for real. The exported names keep the `grammar` prefix
// for backward compat — MessageList already subscribes via them — but the
// channel is shared by both lazy loaders so a KaTeX load reuses the SAME
// subscription and needs no MessageList change.
let grammarVersion = 0;
const grammarSubscribers = new Set<() => void>();

/**
 * Subscribe to "a lazily-loaded render asset just landed" events (a grammar or
 * the KaTeX typesetter). Returns an unsubscribe fn. Used by MessageList to
 * re-render blocks that first rendered against a fallback (plaintext code, or
 * raw-TeX math) before the real asset finished loading.
 */
export function subscribeGrammarLoad(cb: () => void): () => void {
  grammarSubscribers.add(cb);
  return () => grammarSubscribers.delete(cb);
}

/** Monotonic counter bumped each time a lazy render asset lands (for useSyncExternalStore). */
export function getGrammarVersion(): number {
  return grammarVersion;
}

/**
 * Hook invoked AFTER a lazy render asset (grammar or KaTeX) lands. Set by
 * MessageList so markdown.ts can drop the per-message + per-prefix HTML memos
 * that were produced against a fallback. Kept as an injectable callback to
 * avoid an import cycle (markdown.ts must not import the React component that
 * consumes it).
 */
let onGrammarRegistered: (() => void) | null = null;
export function setGrammarCacheInvalidator(fn: (() => void) | null): void {
  onGrammarRegistered = fn;
}

/**
 * Bump the shared version, drop the host's HTML memos, and notify React
 * subscribers — called by BOTH the lazy grammar loader and the lazy KaTeX
 * loader once their async chunk lands, so a stale fallback render re-runs
 * against the real asset.
 */
function notifyLazyAssetLoaded(): void {
  grammarVersion++;
  onGrammarRegistered?.();
  for (const cb of grammarSubscribers) cb();
}

/**
 * Ensure a grammar is registered. If already registered (or in flight, or has
 * no loader) this is a no-op. Otherwise it imports the grammar chunk, registers
 * it under its canonical name, and notifies subscribers. Synchronous callers
 * (the `highlight` callback) fire-and-forget this and use the plaintext
 * fallback until the registration lands.
 */
function ensureGrammar(canonical: string): void {
  if (hljs.getLanguage(canonical)) return;
  if (grammarLoadStarted.has(canonical)) return;
  const loader = loaderByName.get(canonical);
  if (!loader) {
    // No such grammar — mark started so we never retry; plaintext forever.
    grammarLoadStarted.add(canonical);
    return;
  }
  grammarLoadStarted.add(canonical);
  void loader()
    .then((mod) => {
      // Guard against a duplicate registration from a racing caller.
      if (!hljs.getLanguage(canonical)) {
        hljs.registerLanguage(canonical, mod.default);
      }
      // Drop memoized HTML built against the plaintext fallback + re-render so
      // the next pass re-highlights with the real grammar.
      notifyLazyAssetLoaded();
    })
    .catch(() => {
      // Load failed (offline chunk fetch, etc.) — leave on plaintext. Keep it
      // in grammarLoadStarted so we don't hammer a broken chunk every render.
    });
}

// Eagerly register the universal fallback so the synchronous highlight path
// always has a registered language to escape against (no throw, no warning).
hljs.registerLanguage("plaintext", plaintext);

marked.use(
  markedHighlight({
    emptyLangClass: "hljs",
    langPrefix: "hljs language-",
    highlight(code, lang) {
      // Resolve aliases (ts→typescript) before checking registration so a
      // first `ts` block triggers the typescript load, not a "ts" lookup miss.
      const canonical = lang ? canonicalGrammar(lang) : "";
      if (canonical && !hljs.getLanguage(canonical)) {
        // Not registered yet — kick off the async grammar load (no-op if it's
        // already in flight or unknown) and fall back to plaintext for THIS
        // synchronous render. A re-render after the grammar lands highlights it
        // for real (see ensureGrammar / subscribeGrammarLoad).
        ensureGrammar(canonical);
      }
      // `plaintext` is registered eagerly above — always available, even with
      // zero lazy grammars loaded — so the fallback escapes cleanly.
      const language = hljs.getLanguage(canonical) ? canonical : "plaintext";
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
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
    "a",
    "p",
    "span",
    "br",
    "hr",
    "strong",
    "em",
    "del",
    "code",
    "pre",
    "ul",
    "ol",
    "li",
    "blockquote",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "img",
  ],
  ALLOWED_ATTR: ["href", "title", "target", "rel", "class", "src", "alt"],
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS: [
    "style",
    "script",
    "iframe",
    "object",
    "embed",
    "form",
    "input",
    "button",
  ],
  FORBID_ATTR: [
    "onerror",
    "onload",
    "onclick",
    "onmouseover",
    "onfocus",
    "onblur",
  ],
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
  if (
    h.startsWith("/") ||
    h.startsWith("./") ||
    h.startsWith("../") ||
    h.startsWith("?")
  ) {
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
// writes `` `/Users/you/.ssh/id_ed25519` `` must never become a one-click
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

function splitPathAndLine(match: string): {
  path: string;
  line: string | null;
} {
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
    if (
      !/\.(rs|ts|tsx|js|jsx|py|md|json|toml|yml|yaml|sh|html|css)\b/.test(text)
    ) {
      continue;
    }
    // Reset stickiness for each fresh string (CITATION_RE is /g).
    // Perf (low/optimization): we do NOT pre-`.test()` here. The expensive
    // lookbehind+path-alternation regex was previously walked twice per node
    // (a standalone test() then the exec loop). The single exec loop below
    // already short-circuits on no match; we track `produced` so a no-match
    // node skips the DOM rebuild (the tail still appends the full text, so a
    // non-empty `frag` alone can't tell us whether a chip was emitted).
    CITATION_RE.lastIndex = 0;

    // Audit L-F6 (2026-05-28): hoist `code.ownerDocument` once per loop
    // body and fall back to the global `document` so we drop the five
    // `code.ownerDocument!` non-null assertions that previously littered
    // this block. A detached node has a non-null ownerDocument by spec,
    // but the null-assertion cluster read as "we kept hitting the lint
    // wall" — explicit fallback is cleaner.
    const doc = code.ownerDocument ?? document;
    // Build a fragment that interleaves chip anchors with text segments,
    // then replace the inline <code>'s contents wholesale.
    const frag = doc.createDocumentFragment();
    let lastIndex = 0;
    let produced = false;
    let m: RegExpExecArray | null;
    while ((m = CITATION_RE.exec(text)) !== null) {
      if (m.index > lastIndex) {
        frag.appendChild(doc.createTextNode(text.slice(lastIndex, m.index)));
      }
      const matchStr = m[0];
      const { path, line } = splitPathAndLine(matchStr);
      // Reject path-traversal segments — a relative citation must never be
      // able to escape the workspace via `..`. Emit the literal text instead
      // of a clickable chip. The click handler re-checks as defense in depth.
      if (path.split("/").some((seg) => seg === "..")) {
        frag.appendChild(doc.createTextNode(matchStr));
        lastIndex = m.index + matchStr.length;
        continue;
      }
      const a = doc.createElement("a");
      a.className = "citation-chip";
      a.setAttribute("data-path", path);
      if (line) a.setAttribute("data-line", line);
      a.setAttribute("title", matchStr);
      // href="#" so it looks/feels like a link; the click handler in
      // ChatWindow intercepts and prevents default.
      a.setAttribute("href", "#");
      a.textContent = basenameWithLine(matchStr);
      frag.appendChild(a);
      produced = true;
      lastIndex = m.index + matchStr.length;
    }
    // No chip emitted → leave the <code> untouched (avoids needless DOM
    // rebuild for nodes that passed the cheap pre-filter but matched no
    // path-shaped citation).
    if (!produced) continue;
    if (lastIndex < text.length) {
      frag.appendChild(doc.createTextNode(text.slice(lastIndex)));
    }
    // We produced at least one chip — commit the rebuilt contents.
    // Replace the <code>'s children with the new fragment. The <code>
    // wrapper itself stays — the chip just lives inside it.
    while (code.firstChild) code.removeChild(code.firstChild);
    code.appendChild(frag);
  }
}

/* ── Code-block header post-processor ───────────────────────────────────── */
//
// Runs AFTER DOMPurify, same as chipifyCitations. Wraps each fenced
// `<pre><code class="hljs language-x">` block in a `.code-block` div with a
// header row: language label + Copy / Download / soft-wrap-toggle buttons. The
// <button>s are built here via document.createElement — PURIFY_CONFIG
// deliberately FORBIDs <button>, so a model can never author one; ours are
// injected post-sanitize and carry no inline handlers (clicks are handled by a
// delegated listener in MessageList, keeping this output a pure string).

// Map a language label (from the `language-<lang>` class) to a plausible file
// extension for the Download button's inferred filename. Falls back to `txt`.
const LANG_FILE_EXT: Record<string, string> = {
  javascript: "js",
  js: "js",
  typescript: "ts",
  ts: "ts",
  tsx: "tsx",
  jsx: "jsx",
  python: "py",
  py: "py",
  rust: "rs",
  rs: "rs",
  bash: "sh",
  sh: "sh",
  zsh: "sh",
  shell: "sh",
  json: "json",
  css: "css",
  html: "html",
  xml: "xml",
  sql: "sql",
  yaml: "yaml",
  yml: "yml",
  markdown: "md",
  md: "md",
  go: "go",
  java: "java",
  csharp: "cs",
  cs: "cs",
  cpp: "cpp",
  c: "c",
  dockerfile: "dockerfile",
  diff: "diff",
};

/**
 * Wrap `<pre><code>` blocks in a `.code-block` header chrome.
 *
 * Exported for unit tests — production code should use `renderMarkdown`
 * which runs this automatically.
 */
export function wrapCodeBlocks(root: HTMLElement | DocumentFragment): void {
  for (const pre of Array.from(root.querySelectorAll("pre"))) {
    // Idempotence guard: skip blocks that already carry the chrome.
    if (pre.parentElement?.classList.contains("code-block")) continue;
    const code = pre.querySelector("code");
    if (!code) continue;
    const doc = pre.ownerDocument ?? document;
    // marked-highlight emits `hljs language-<lang>` (or bare `hljs` for a
    // fence with no info string) — fall back to a generic "code" label.
    const langMatch = /\blanguage-([\w#+.-]+)/.exec(code.className);
    const lang =
      langMatch && langMatch[1] !== "plaintext" ? langMatch[1] : "code";

    const wrapper = doc.createElement("div");
    wrapper.className = "code-block";
    const header = doc.createElement("div");
    header.className = "code-block-header";
    const label = doc.createElement("span");
    label.className = "code-lang";
    label.textContent = lang;
    // Button group: soft-wrap toggle, Download, Copy. All handled by the
    // delegated listener in MessageList — no inline handlers.
    const actions = doc.createElement("span");
    actions.className = "code-block-actions";
    const wrapBtn = doc.createElement("button");
    wrapBtn.className = "code-wrap-btn";
    wrapBtn.type = "button";
    wrapBtn.title = "Toggle soft wrap";
    wrapBtn.textContent = "Wrap";
    const dlBtn = doc.createElement("button");
    dlBtn.className = "code-download-btn";
    dlBtn.type = "button";
    // Inferred filename — the delegated handler reads `data-filename` to build
    // the download blob. e.g. python → snippet.py.
    const ext = LANG_FILE_EXT[lang] ?? "txt";
    dlBtn.setAttribute("data-filename", `snippet.${ext}`);
    dlBtn.title = `Download as snippet.${ext}`;
    dlBtn.textContent = "Download";
    const btn = doc.createElement("button");
    btn.className = "code-copy-btn";
    btn.type = "button";
    btn.textContent = "Copy";
    actions.appendChild(wrapBtn);
    actions.appendChild(dlBtn);
    actions.appendChild(btn);
    header.appendChild(label);
    header.appendChild(actions);
    pre.replaceWith(wrapper);
    wrapper.appendChild(header);
    wrapper.appendChild(pre);
  }
}

/* ── KaTeX math pre/post-pass ───────────────────────────────────────────── */
//
// Math is EXTRACTED from the markdown source BEFORE marked runs — marked
// would otherwise mangle TeX (`*` becomes <em>, `\(` is a markdown escape
// sequence that collapses to `(`, `_` opens emphasis…). Each math span is
// replaced by a placeholder built from Unicode private-use sentinels
// (U+E000 <index> U+E001) that survives marked AND DOMPurify untouched as
// plain text. After sanitization the placeholder text nodes are swapped for
// rendered KaTeX output (or, before the lazy KaTeX chunk has landed, a raw-TeX
// placeholder span that re-renders once it does — see the Lazy KaTeX section).
//
// Sanitizer note: KaTeX markup (<span class="katex">…, MathML <math>…) is
// NOT in PURIFY_CONFIG's allowlist and must not be — widening the allowlist
// for model-authored HTML would grow the XSS surface for every message. The
// KaTeX HTML is instead injected AFTER DOMPurify, which is safe because it
// is generated locally by KaTeX's renderToString from a plain-text TeX string
// with throwOnError:false — KaTeX escapes its input, so the output cannot
// carry attacker-controlled markup. The raw-TeX placeholder shown pre-load is
// likewise built by escaping the TeX string, so it carries no markup either.

interface MathSegment {
  tex: string;
  display: boolean;
}

const MATH_OPEN = "\uE000";
const MATH_CLOSE = "\uE001";
const MATH_TOKEN_RE = /\uE000(\d+)\uE001/g;

/* ── Lazy KaTeX loading (perf) ──────────────────────────────────────────── */
//
// KaTeX is dynamic-`import()`ed (along with its stylesheet) the FIRST time a
// message actually contains a formula — so a no-math reply never pulls the
// ~260 KB typesetter + ~270 KB of fonts/CSS into the chat boot graph. This
// mirrors the lazy highlight.js grammar plumbing above: `renderTex` is
// SYNCHRONOUS (it runs inside the post-sanitize DOM pass), but `import()` is
// async, so the first render of a formula before KaTeX has landed emits a
// readable raw-TeX placeholder and kicks off the load. When KaTeX lands we drop
// the (placeholder-tainted) per-formula memo + the message HTML memos and
// notify subscribers, so the chat view re-renders with real typesetting.

// Resolved KaTeX module default (`null` until the first formula triggers the
// load). We hold the MODULE OBJECT, not a bound `renderToString` reference, and
// access `.renderToString` at call time — so a test that spies on
// `katex.renderToString` still intercepts our calls. `import type` is erased at
// compile time (zero runtime bytes), so the lazy-load win is intact while we
// keep KaTeX's exact types.
type KatexModule = typeof import("katex").default;
let katexMod: KatexModule | null = null;
let katexLoadStarted = false;

// Kick off the one-time KaTeX (+ stylesheet) load. No-op once started/loaded.
// On resolve we invalidate the placeholder-tainted caches and notify so any
// already-rendered formula re-typesets for real.
function ensureKatex(): void {
  if (katexMod || katexLoadStarted) return;
  katexLoadStarted = true;
  // Load the JS and the layout stylesheet (+ bundled fonts) together so the
  // glyphs are correctly positioned the instant `.katex` markup appears. The
  // CSS import resolves to a side-effecting chunk under Vite. We don't gate the
  // JS readiness on the CSS settling — the worst case is one frame of
  // unstyled-but-present math, immediately corrected.
  void import("katex/dist/katex.min.css").catch(() => {
    // A failed stylesheet fetch shouldn't block typesetting — math still
    // renders, just unstyled until a later load. Swallow.
  });
  void import("katex")
    .then((mod) => {
      katexMod = mod.default;
      // Drop the per-formula memo: any entry created while KaTeX was loading is
      // a placeholder, not real markup, and must not be served on re-render.
      katexCache.clear();
      // Drop the host HTML memos + re-render so placeholders become real math.
      notifyLazyAssetLoaded();
    })
    .catch(() => {
      // Load failed (offline chunk fetch, etc.). Allow a retry on the next
      // formula sighting rather than permanently stranding math as raw TeX.
      katexLoadStarted = false;
    });
}

// Raw-TeX placeholder shown for ONE render while KaTeX loads. Escaped (it's
// injected via innerHTML by renderMathPlaceholders) and tagged so it can be
// styled/identified; the wrapper re-renders into real KaTeX once the module
// lands (see ensureKatex → notifyLazyAssetLoaded).
function texPlaceholder(tex: string, display: boolean): string {
  const cls = display ? "katex-pending katex-pending-display" : "katex-pending";
  return `<span class="${cls}">${escapeHtml(tex)}</span>`;
}

// Per-formula render memo. The message-level markdownCache in MessageList
// caches whole renderMarkdown outputs, but during streaming the message text
// changes on every chunk — missing that cache while formulas early in the
// message are already final. Memoizing per (tex, mode) keeps KaTeX (the
// slowest stage of the pipeline) from re-typesetting them each chunk. FIFO
// eviction bounds it, mirroring markdownCache.
const KATEX_CACHE_MAX = 300;
const katexCache = new Map<string, string>();
function renderTex(tex: string, display: boolean): string {
  const key = (display ? "D:" : "I:") + tex;
  const hit = katexCache.get(key);
  if (hit !== undefined) return hit;
  // KaTeX not loaded yet: emit a raw-TeX placeholder and trigger the lazy load.
  // Deliberately NOT cached — a later render (after the module lands + the memo
  // is cleared) must produce real typesetting, not a stale placeholder.
  if (!katexMod) {
    ensureKatex();
    return texPlaceholder(tex, display);
  }
  // Access `.renderToString` at call time (not a captured reference) so a test
  // spy on `katex.renderToString` still intercepts our calls.
  const html = katexMod.renderToString(tex, {
    displayMode: display,
    throwOnError: false,
  });
  if (katexCache.size >= KATEX_CACHE_MAX) {
    const firstKey = katexCache.keys().next().value;
    if (firstKey !== undefined) katexCache.delete(firstKey);
  }
  katexCache.set(key, html);
  return html;
}

// Ranges of the source string that belong to code (fenced blocks + inline
// spans) — math delimiters inside them must stay literal text.
function codeRanges(md: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  // Fenced blocks: an opening fence of ≥3 backticks/tildes closes at the
  // next line with the same char and at least the same run length. An
  // unterminated fence protects through EOF — matching how marked treats a
  // streaming-truncated fence.
  const lines = md.split("\n");
  let pos = 0;
  let openStart = -1;
  let fenceChar = "";
  let fenceLen = 0;
  for (const line of lines) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (m) {
      const run = m[1];
      if (openStart < 0) {
        openStart = pos;
        fenceChar = run[0];
        fenceLen = run.length;
      } else if (run[0] === fenceChar && run.length >= fenceLen) {
        ranges.push([openStart, pos + line.length]);
        openStart = -1;
      }
    }
    pos += line.length + 1;
  }
  if (openStart >= 0) ranges.push([openStart, md.length]);
  // Inline code spans (`…`) outside the fenced ranges.
  const inFence = (i: number) => ranges.some(([s, e]) => i >= s && i < e);
  const spanRe = /(`+)([^`]+?)\1(?!`)/g;
  let m: RegExpExecArray | null;
  while ((m = spanRe.exec(md)) !== null) {
    if (!inFence(m.index)) ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

// Replace math spans with placeholders, returning the rewritten source plus
// the extracted segments (indexed by placeholder number).
function extractMath(md: string): { text: string; segments: MathSegment[] } {
  const segments: MathSegment[] = [];
  // Strip any pre-existing sentinel chars so model output can't forge or
  // duplicate placeholders.
  const src = md.replace(/[\uE000\uE001]/g, "");
  // Cheap rejection — no `$` and no `\(`/`\[` means no math to extract.
  if (!/[$]|\\[([]/.test(src)) return { text: src, segments };

  const protectedRanges = codeRanges(src);
  const overlapsCode = (s: number, e: number) =>
    protectedRanges.some(([ps, pe]) => s < pe && e > ps);

  interface Hit {
    start: number;
    end: number;
    tex: string;
    display: boolean;
  }
  const hits: Hit[] = [];
  const collect = (re: RegExp, display: boolean) => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (overlapsCode(start, end)) continue;
      // Skip anything overlapping an earlier (higher-priority) hit — e.g.
      // a `$…$` fragment inside an already-captured `$$…$$`.
      if (hits.some((h) => start < h.end && end > h.start)) continue;
      const tex = m[1].trim();
      if (!tex) continue;
      hits.push({ start, end, tex, display });
    }
  };
  // Order matters: display forms first so `$$…$$` isn't half-eaten by the
  // single-dollar matcher.
  collect(/\$\$([\s\S]+?)\$\$/g, true);
  collect(/\\\[([\s\S]+?)\\\]/g, true);
  collect(/\\\(([\s\S]+?)\\\)/g, false);
  // Inline `$…$` — pandoc's conservative dollar heuristic: the opening $
  // must be followed by a non-space char and not be escaped or glued to a
  // word/another $; the closing $ must follow a non-space char and must NOT
  // be followed by a digit (keeps "$5 and $10" as currency, not math).
  // Single-line only.
  collect(/(?<![\\$\w])\$(?!\s)([^$\n]*[^\s$])\$(?![\d$])/g, false);

  hits.sort((a, b) => a.start - b.start);
  let out = "";
  let last = 0;
  for (const h of hits) {
    out += src.slice(last, h.start);
    out += `${MATH_OPEN}${segments.length}${MATH_CLOSE}`;
    segments.push({ tex: h.tex, display: h.display });
    last = h.end;
  }
  out += src.slice(last);
  return { text: out, segments };
}

// Depth-first text-node collection that never descends into code — the
// extractor skipped code ranges, so placeholders can't legitimately appear
// there (and the sentinel strip above makes forgeries impossible); the guard
// stays cheap + explicit.
function collectTextNodes(node: Node, out: Text[]): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      out.push(child as Text);
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = (child as Element).tagName;
      if (tag === "PRE" || tag === "CODE") continue;
      collectTextNodes(child, out);
    }
  }
}

/**
 * Swap math placeholders (see `extractMath`) for rendered KaTeX markup.
 *
 * Exported for unit tests — production code should use `renderMarkdown`
 * which runs this automatically.
 */
export function renderMathPlaceholders(
  root: HTMLElement | DocumentFragment,
  segments: MathSegment[],
): void {
  if (segments.length === 0) return;
  const textNodes: Text[] = [];
  collectTextNodes(root, textNodes);
  for (const node of textNodes) {
    const text = node.nodeValue ?? "";
    if (!text.includes(MATH_OPEN)) continue;
    const doc = node.ownerDocument ?? document;
    const frag = doc.createDocumentFragment();
    let last = 0;
    MATH_TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MATH_TOKEN_RE.exec(text)) !== null) {
      if (m.index > last) {
        frag.appendChild(doc.createTextNode(text.slice(last, m.index)));
      }
      const seg = segments[Number(m[1])];
      if (seg) {
        // Trusted injection point — post-sanitize, but the HTML is
        // katex.renderToString output over a plain TeX string (see the
        // sanitizer note in the section header above).
        const host = doc.createElement("span");
        host.innerHTML = renderTex(seg.tex, seg.display);
        while (host.firstChild) frag.appendChild(host.firstChild);
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) {
      frag.appendChild(doc.createTextNode(text.slice(last)));
    }
    node.parentNode?.replaceChild(frag, node);
  }
}

export function renderMarkdown(md: string): string {
  if (!md) return "";
  // SSR/test-environment guard: without a document the DOM post-passes
  // can't run, so skip math extraction too (placeholders would leak into
  // the output as raw sentinel chars).
  if (typeof document === "undefined") {
    const raw = marked.parse(md, { async: false }) as string;
    return DOMPurify.sanitize(raw, PURIFY_CONFIG) as string;
  }
  const { text, segments } = extractMath(md);
  const raw = marked.parse(text, { async: false }) as string;
  const sanitized = DOMPurify.sanitize(raw, PURIFY_CONFIG) as string;
  // Post-sanitize: parse the trusted HTML into a detached container, run
  // chip-ification + code-block chrome + math substitution, return the
  // serialized output. Building DOM nodes via document.createElement (not
  // innerHTML) keeps the first two XSS-safe; the math pass injects only
  // locally-generated KaTeX output (see section comment).
  const container = document.createElement("div");
  container.innerHTML = sanitized;
  chipifyCitations(container);
  wrapCodeBlocks(container);
  renderMathPlaceholders(container, segments);
  return container.innerHTML;
}

/* ── User-message code rendering ─────────────────────────────────────────── */
//
// User bubbles are otherwise PLAIN text — a human typed them, with no markdown
// intent, so running the full marked pipeline would surprise them (a line that
// starts with `#` becoming an <h1>, `*foo*` italicizing, a `1.` list, etc.).
// But a user who PASTES code wants it to look like code: monospace, syntax
// highlight, a copy button. So we render ONLY two markdown constructs in user
// messages — fenced ``` blocks and inline `code` spans — and leave everything
// else as the literal text it was typed as (newlines preserved by the bubble's
// `white-space: pre-wrap`).
//
// `containsUserCode` lets the caller skip the whole machinery (and keep the
// cheap plain-text path) for the common case of a message with no code.

// A fenced block: opening fence of ≥3 backticks/tildes + optional info string,
// content, closing fence. Tolerates an UNTERMINATED trailing fence (a half-
// pasted block) by consuming to end-of-input — matching marked's behavior.
const USER_FENCE_RE =
  /(^|\n)([ \t]{0,3})(`{3,}|~{3,})([^\n`]*)\n([\s\S]*?)(?:\n\2?\3[ \t]*(?=\n|$)|$)/g;
// Inline code span: one or more backticks, non-greedy content, matching run.
const USER_INLINE_CODE_RE = /(`+)([^`]+?)\1(?!`)/g;

/** Cheap predicate — does this user text contain a fenced or inline code span? */
export function containsUserCode(text: string): boolean {
  if (!text) return false;
  // A fenced block needs ``` / ~~~ at a line start; an inline span needs a
  // backtick pair. Both require at least one backtick or tilde-run.
  if (/(^|\n)[ \t]{0,3}(`{3,}|~{3,})/.test(text)) return true;
  USER_INLINE_CODE_RE.lastIndex = 0;
  return USER_INLINE_CODE_RE.test(text);
}

// Render a single fenced block to a highlighted `<pre><code>` string via the
// SAME marked-highlight pipeline (so lazy grammar loading + theming apply),
// then wrap it in the standard code-block chrome.
function renderUserFence(info: string, body: string): string {
  const lang = info.trim().split(/\s+/)[0] ?? "";
  // Build the minimal markdown for just this fence and reuse renderMarkdown so
  // we inherit highlight + DOMPurify + wrapCodeBlocks. Strip a single trailing
  // newline the splitter may have captured.
  const fenceMd = "```" + lang + "\n" + body.replace(/\n$/, "") + "\n```";
  return renderMarkdown(fenceMd);
}

// Render inline `code` spans inside a prose segment, escaping everything else.
// Returns an HTML string with literal text escaped and spans wrapped in
// <code> (the inline-code chrome from chat.css).
function renderUserProse(text: string): string {
  let out = "";
  let last = 0;
  USER_INLINE_CODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = USER_INLINE_CODE_RE.exec(text)) !== null) {
    if (m.index > last) out += escapeHtml(text.slice(last, m.index));
    out += "<code>" + escapeHtml(m[2]) + "</code>";
    last = m.index + m[0].length;
  }
  if (last < text.length) out += escapeHtml(text.slice(last));
  return out;
}

/**
 * Render a USER message: fenced + inline code get the code treatment, all
 * other text stays literal (escaped). Returns an HTML string suitable for
 * `dangerouslySetInnerHTML`. Prose newlines are preserved by the bubble's
 * `white-space: pre-wrap` (the wrapping element keeps that), so we do NOT
 * inject <br>. Callers should gate on `containsUserCode` first and fall back
 * to a plain text node when it returns false.
 *
 * Exported for unit tests.
 */
export function renderUserContent(md: string): string {
  if (!md) return "";
  if (typeof document === "undefined") {
    // No DOM (SSR/test) → can't run wrapCodeBlocks chrome; just escape so the
    // output is still safe and shows the literal source.
    return escapeHtml(md);
  }
  let out = "";
  let last = 0;
  USER_FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = USER_FENCE_RE.exec(md)) !== null) {
    // m[1] is the leading "" or "\n" the fence regex consumed before the
    // fence — keep it as literal prose so spacing is preserved.
    const lead = m[1] ?? "";
    const proseEnd = m.index + lead.length;
    if (proseEnd > last) out += renderUserProse(md.slice(last, proseEnd));
    out += renderUserFence(m[4] ?? "", m[5] ?? "");
    last = m.index + m[0].length;
  }
  if (last < md.length) out += renderUserProse(md.slice(last));
  return out;
}
