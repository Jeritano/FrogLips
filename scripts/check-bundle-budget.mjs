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
//     detached.html (1 convo)  ~793 KB  → cap 900 KB   (legitimately loads chat+markdown+katex)
const WINDOW_BUDGETS = [
  { html: "index.html", label: "main App", maxBytes: 260 * KB },
  { html: "quick.html", label: "Quick Prompt popover", maxBytes: 240 * KB },
  { html: "detached.html", label: "detached conversation", maxBytes: 900 * KB },
];

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

// Pull the entry script + every modulepreload href from a built HTML file.
// Only JS assets count toward the boot-graph budget (CSS is cheap + separate).
function bootGraphAssets(htmlPath) {
  const html = readFileSync(htmlPath, "utf8");
  const assets = new Set();
  const scriptRe = /<script[^>]*\bsrc="([^"]+\.js)"/g;
  const preloadRe =
    /<link[^>]*\brel="modulepreload"[^>]*\bhref="([^"]+\.js)"/g;
  let m;
  while ((m = scriptRe.exec(html)) !== null) assets.add(m[1]);
  while ((m = preloadRe.exec(html)) !== null) assets.add(m[1]);
  return [...assets];
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

for (const { html, label, maxBytes } of WINDOW_BUDGETS) {
  const htmlPath = join(distDir, html);
  if (!existsSync(htmlPath)) {
    fail(`missing entry HTML: ${html} (${label})`);
    anyFail = true;
    continue;
  }
  const assets = bootGraphAssets(htmlPath);
  let total = 0;
  const missing = [];
  for (const ref of assets) {
    const bytes = fileBytes(assetToFile(ref));
    if (bytes == null) {
      missing.push(ref);
      continue;
    }
    total += bytes;
  }
  if (missing.length) {
    fail(`${html}: referenced assets not found on disk: ${missing.join(", ")}`);
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
