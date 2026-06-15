#!/usr/bin/env node
// Enforced bundle budget — fails the build (exit 1) when a window's boot graph
// or a watched chunk grows past a committed limit.
//
// Why this exists (cleanup #3, formerly log-only): vite.config.ts sets
// `chunkSizeWarningLimit`, but that only PRINTS a warning — it never fails a
// build, and the warning already fires on every build, so it's noise, not a
// gate. This script turns the budget into a hard tripwire: a refactor that
// re-welds the markdown renderer into the entry, drops a heavy dep into the
// shared `vendor` chunk, or makes the lightweight Quick Prompt popover pull the
// chat/markdown payload again will fail CI / `release.sh` instead of silently
// regressing startup weight.
//
// What it measures, per webview HTML entry: the BOOT GRAPH — the entry
// `<script type="module">` plus every `<link rel="modulepreload">` Vite emits
// into that HTML. That's exactly the JS a window fetches+parses before it can
// render. Plus a couple of individual watched chunks. Sizes are RAW
// (post-minify, pre-gzip) bytes of the built files — deterministic and
// independent of the content hash in each filename.
//
// Limits are committed below at "current size + small headroom" so the gate
// passes today and catches regressions. Bumping a limit is a deliberate,
// reviewable diff — that's the point.
//
// Usage:  node scripts/check-bundle-budget.mjs [distDir]
// Default distDir: ../dist relative to this script.

import { readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2]
  ? process.argv[2]
  : join(here, "..", "dist");

const KB = 1024;

// ── Committed budgets ───────────────────────────────────────────────────────
// Per-window BOOT GRAPH ceilings (entry script + all modulepreloads in its
// HTML). Numbers reflect the 2026-06-14 split (separate Vite entries + markdown
// chunk split into markdown/highlight/katex + a dedicated react `vendor`
// chunk). Headroom is intentionally small so real growth trips the gate.
//
//   measured 2026-06-14 (raw bytes):
//     index.html (main App)    ~199 KB  → cap 260 KB
//     quick.html (Quick Prompt)~198 KB  → cap 240 KB   ← must stay chat/markdown-free
//     detached.html (1 convo)  ~914 KB  → cap 940 KB   (legitimately loads chat+markdown+katex;
//        +~14 KB in v0.14.4 from new MessageList chat features it renders on first paint:
//        reasoning "Thinking" disclosure, progressive-streaming prefix render, jump-to-latest
//        pill, update_plan checklist, code-block download/soft-wrap toolbar)
//
// cssMaxBytes — render-blocking stylesheet weight (every `<link rel="stylesheet">`
// the HTML emits). Previously the gate was JS-only and blind to CSS, so the full
// 151 KB App.css aggregator could leak onto the popover unchecked (review finding
// 2026-06-14). Caps are committed at "current weight + headroom" like the JS ones.
//   measured 2026-06-14 (raw bytes):
//     index.html               ~151 KB  → cap 160 KB   ← the full app legitimately render-blocks App.css (preloaded; no FOUC)
//     quick.html               ~151 KB  → cap 170 KB   ← App.css aggregator; trim toward a lean quick.css (follow-up)
//     detached.html            ~182 KB  → cap 210 KB   (katex + ChatWindow + App.css)
const WINDOW_BUDGETS = [
  { html: "index.html", label: "main App", maxBytes: 260 * KB, cssMaxBytes: 160 * KB },
  { html: "quick.html", label: "Quick Prompt popover", maxBytes: 240 * KB, cssMaxBytes: 170 * KB },
  { html: "detached.html", label: "detached conversation", maxBytes: 940 * KB, cssMaxBytes: 210 * KB },
];

// Boot-graph sanity floor: every window must boot at least its entry script.
// A silent under-parse (e.g. a future Vite attribute-order change that the
// modulepreload regex no longer matches) would otherwise report a window WELL
// under budget while actually loading more — hiding regressions instead of
// flagging them. We assert each window references ≥1 JS asset and a plausible
// minimum total so an empty/under-parse fails loudly. (Review finding 2026-06-14.)
const MIN_BOOT_GRAPH_BYTES = 50 * KB; // smallest real window (quick) is ~198 KB

// Individual chunk ceilings — guard the pieces most likely to balloon.
//   markdown (marked+dompurify) ~67 KB → cap 100 KB  (base renderer; keep lean)
//   vendor   (react/react-dom)  ~188 KB → cap 230 KB  (shared by every window)
const CHUNK_BUDGETS = [
  { prefix: "markdown-", label: "markdown base renderer", maxBytes: 100 * KB },
  { prefix: "vendor-", label: "react vendor", maxBytes: 230 * KB },
];

// ── Helpers ─────────────────────────────────────────────────────────────────
function fail(msg) {
  console.error(`✗ bundle-budget: ${msg}`);
  process.exitCode = 1;
}

function fileBytes(absPath) {
  try {
    return statSync(absPath).size;
  } catch {
    return null;
  }
}

function fmt(bytes) {
  return `${(bytes / KB).toFixed(1)} KB`;
}

// Extract an attribute value from a single tag string, order-independent.
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : null;
}

// Pull the entry script + every modulepreload href (JS boot graph) from a built
// HTML file. The boot graph is the JS a window fetches+parses before it can
// render; CSS is measured separately (see bootGraphCss).
//
// Parsing is attribute-ORDER-TOLERANT: we match each <link>/<script> tag, then
// read rel/href/src independently. The earlier version required the literal
// order `rel="modulepreload"` THEN `href`, so a Vite/Rollup upgrade that
// reordered attributes (e.g. href before rel) would silently match nothing and
// undercount the boot graph — passing CI while loading more. (Review finding.)
function bootGraphAssets(htmlPath) {
  const html = readFileSync(htmlPath, "utf8");
  const assets = new Set();
  const scriptRe = /<script\b[^>]*>/g;
  const linkRe = /<link\b[^>]*>/g;
  let m;
  while ((m = scriptRe.exec(html)) !== null) {
    const src = attr(m[0], "src");
    if (src && src.endsWith(".js")) assets.add(src);
  }
  while ((m = linkRe.exec(html)) !== null) {
    if (attr(m[0], "rel") !== "modulepreload") continue;
    const href = attr(m[0], "href");
    if (href && href.endsWith(".js")) assets.add(href);
  }
  return [...assets];
}

// Pull every render-blocking `<link rel="stylesheet">` href from a built HTML
// file, order-tolerant like bootGraphAssets. These load before first paint.
function bootGraphCss(htmlPath) {
  const html = readFileSync(htmlPath, "utf8");
  const css = new Set();
  const linkRe = /<link\b[^>]*>/g;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    if (attr(m[0], "rel") !== "stylesheet") continue;
    const href = attr(m[0], "href");
    if (href && href.endsWith(".css")) css.add(href);
  }
  return [...css];
}

// Resolve an HTML-referenced asset path (e.g. "/assets/foo.js") to a file on
// disk under distDir.
function assetToFile(ref) {
  const clean = ref.replace(/^\//, "");
  return join(distDir, clean);
}

// ── Run ─────────────────────────────────────────────────────────────────────
if (!existsSync(distDir)) {
  fail(`dist dir not found: ${distDir} (run \`npm run build\` first)`);
  process.exit(1);
}

console.log(`▶ bundle-budget: checking ${distDir}`);
let anyFail = false;

// Sum the on-disk bytes of a set of HTML-referenced asset refs. Records any
// ref whose file is missing into `missing` (caller fails on that).
function sumAssets(refs, missing) {
  let total = 0;
  for (const ref of refs) {
    const bytes = fileBytes(assetToFile(ref));
    if (bytes == null) {
      missing.push(ref);
      continue;
    }
    total += bytes;
  }
  return total;
}

for (const { html, label, maxBytes, cssMaxBytes } of WINDOW_BUDGETS) {
  const htmlPath = join(distDir, html);
  if (!existsSync(htmlPath)) {
    fail(`missing entry HTML: ${html} (${label})`);
    anyFail = true;
    continue;
  }
  const assets = bootGraphAssets(htmlPath);
  const missing = [];
  const total = sumAssets(assets, missing);
  if (missing.length) {
    fail(`${html}: referenced assets not found on disk: ${missing.join(", ")}`);
    anyFail = true;
  }

  // Floor assertion — a parse that finds no JS, or an implausibly tiny total,
  // means the HTML changed shape and the regex silently under-counted. Fail
  // loudly rather than report a window "well under budget" while it loads more.
  if (assets.length === 0 || total < MIN_BOOT_GRAPH_BYTES) {
    fail(
      `${html} (${label}) boot graph parsed only ${assets.length} asset(s) ` +
        `(${fmt(total)} < floor ${fmt(MIN_BOOT_GRAPH_BYTES)}) — HTML shape ` +
        `changed and the parser likely under-counted; inspect ${html}.`,
    );
    anyFail = true;
  }

  const status = total <= maxBytes ? "ok" : "OVER";
  const line = `  ${html.padEnd(14)} ${label.padEnd(24)} boot graph ${fmt(
    total,
  ).padStart(9)} / ${fmt(maxBytes).padStart(9)}  [${status}]`;
  if (total > maxBytes) {
    console.error(line);
    fail(
      `${html} (${label}) boot graph ${fmt(total)} exceeds budget ${fmt(
        maxBytes,
      )} by ${fmt(total - maxBytes)}`,
    );
    anyFail = true;
  } else {
    console.log(line);
  }

  // Render-blocking CSS budget — keeps the popover from quietly re-welding the
  // full app stylesheet. cssMaxBytes is optional (older entries default to 0).
  const cssCap = cssMaxBytes ?? 0;
  const cssRefs = bootGraphCss(htmlPath);
  const cssMissing = [];
  const cssTotal = sumAssets(cssRefs, cssMissing);
  if (cssMissing.length) {
    fail(
      `${html}: referenced stylesheets not found on disk: ${cssMissing.join(", ")}`,
    );
    anyFail = true;
  }
  const cssStatus = cssTotal <= cssCap ? "ok" : "OVER";
  const cssLine = `  ${html.padEnd(14)} ${label.padEnd(24)} css        ${fmt(
    cssTotal,
  ).padStart(9)} / ${fmt(cssCap).padStart(9)}  [${cssStatus}]`;
  if (cssTotal > cssCap) {
    console.error(cssLine);
    fail(
      `${html} (${label}) render-blocking CSS ${fmt(cssTotal)} exceeds budget ${fmt(
        cssCap,
      )} by ${fmt(cssTotal - cssCap)}`,
    );
    anyFail = true;
  } else {
    console.log(cssLine);
  }
}

// Read the assets dir once to resolve hashed chunk names by prefix.
import { readdirSync } from "node:fs";
let assetFiles = [];
try {
  assetFiles = readdirSync(join(distDir, "assets"));
} catch {
  fail(`no assets/ dir under ${distDir}`);
  process.exit(1);
}

for (const { prefix, label, maxBytes } of CHUNK_BUDGETS) {
  const matches = assetFiles.filter(
    (f) => f.startsWith(prefix) && f.endsWith(".js"),
  );
  if (matches.length === 0) {
    fail(`watched chunk "${prefix}*" (${label}) not found — chunking changed?`);
    anyFail = true;
    continue;
  }
  for (const f of matches) {
    const bytes = fileBytes(join(distDir, "assets", f));
    const status = bytes <= maxBytes ? "ok" : "OVER";
    const line = `  ${f.padEnd(28)} ${label.padEnd(22)} ${fmt(bytes).padStart(
      9,
    )} / ${fmt(maxBytes).padStart(9)}  [${status}]`;
    if (bytes > maxBytes) {
      console.error(line);
      fail(
        `chunk ${f} (${label}) ${fmt(bytes)} exceeds budget ${fmt(maxBytes)}`,
      );
      anyFail = true;
    } else {
      console.log(line);
    }
  }
}

if (anyFail) {
  console.error(
    "\n✗ bundle-budget FAILED. Either trim the regression or, if the growth " +
      "is intended, bump the committed limit in scripts/check-bundle-budget.mjs.",
  );
  process.exit(1);
}
console.log("✓ bundle-budget: all entries + chunks within budget");
