import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  // Maturity review P1 #20 + perf review (2026-06-14): the heavy
  // markdown/syntax-highlight + sanitization deps are split off the entry
  // graph. Two changes work together:
  //   1. SEPARATE WINDOW ENTRIES (rollupOptions.input below). The three
  //      webviews each boot from their own HTML so the lightweight Quick
  //      Prompt popover (quick.html) never reaches the markdown renderer —
  //      previously the single index.html entry statically imported the
  //      markdown chunk, modulepreloading ~415 KB JS + 270 KB katex fonts
  //      onto a window that only shows plain <pre> text.
  //   2. FINER manualChunks (below): marked + dompurify (the base renderer
  //      needed to show ANY message) live in `markdown`; highlight.js and
  //      katex split into their own `highlight` / `katex` chunks so they
  //      cache independently and only ship to windows that render chat.
  // markdown.ts stays a STATIC import of katex/hljs: `renderMarkdown` is
  // synchronous (its unit tests assert `class="katex"` and highlighted
  // <pre><code> appear in the first synchronous call), so the libs must be
  // resident when it runs. They are no longer pulled into chat-less windows,
  // which is where the win is. React-flow IS genuinely deferred: its only
  // importer (WorkflowsPage) is React.lazy, so chat-only sessions never
  // download it.
  build: {
    // Audit M17 (2026-05-27): per-chunk size warning. This stays a soft,
    // log-only nudge during `vite build` — the ENFORCED gate now lives in
    // scripts/check-bundle-budget.mjs (cleanup #3, wired into release.sh and
    // `npm run check:bundle`), which fails the build when a window's boot
    // graph or a watched chunk exceeds a committed limit. Keep this warning
    // limit a touch above the markdown base chunk so it doesn't cry wolf on
    // every build, while the budget script catches real regressions hard.
    chunkSizeWarningLimit: 300,
    rollupOptions: {
      // One HTML entry per webview. The main App boots from index.html; the
      // menu-bar popover from quick.html; a detached single-conversation
      // window from detached.html. Rust (quick_prompt.rs / commands/misc.rs)
      // points each WebviewWindow at its matching file.
      input: {
        main: resolve(rootDir, "index.html"),
        quick: resolve(rootDir, "quick.html"),
        detached: resolve(rootDir, "detached.html"),
      },
      output: {
        // Perf review C6 + M27 (2026-06-09), refined 2026-06-14:
        // - The `reactflow: ["@xyflow/react"]` entry is GONE. The object-form
        //   manual chunk forced 189 KB of xyflow+d3 to fetch/parse/execute on
        //   every boot even though the only importer (WorkflowsPage) is
        //   React.lazy — Rollup now folds it into that async chunk, so
        //   chat-only sessions never load it.
        // - Function form so subpath imports are matched by path: the old
        //   array form matched only package ENTRY ids, so
        //   `highlight.js/lib/languages/*` grammar subpaths leaked into the
        //   main chunk.
        // - The single welded `markdown` chunk (~415 KB) is now split three
        //   ways so the pieces cache + load independently:
        //     * `katex`     — the math typesetter (~270 KB); by far the
        //                     largest piece and only needed for messages that
        //                     contain TeX.
        //     * `highlight` — highlight.js core + the registered grammars;
        //                     needed only for fenced code blocks.
        //     * `markdown`  — marked + marked-highlight + dompurify, i.e. the
        //                     base renderer needed to display ANY message.
        //   All three still load when a chat view mounts (renderMarkdown is
        //   synchronous), but they no longer ship to the Quick Prompt window,
        //   and a katex/grammar version bump no longer busts the others' cache.
        manualChunks(id: string) {
          if (id.includes("node_modules/katex")) return "katex";
          if (id.includes("node_modules/highlight.js")) return "highlight";
          if (
            id.includes("node_modules/marked") ||
            id.includes("node_modules/dompurify")
          ) {
            return "markdown";
          }
          // React/react-dom/scheduler into a dedicated `vendor` chunk that
          // every entry needs anyway. Without this, Rollup's shared CJS-interop
          // helper (getDefaultExportFromCjs) co-located inside the `highlight`
          // chunk and react-dom imported it from there — statically dragging
          // 85 KB of highlight.js onto EVERY window (incl. the chat-less Quick
          // Prompt popover). Co-locating the helper with vendor instead makes
          // `highlight` a true leaf that ships only to windows rendering chat.
          if (
            id.includes("node_modules/react/") ||
            id.includes("node_modules/react-dom/") ||
            id.includes("node_modules/scheduler/")
          ) {
            return "vendor";
          }
        },
      },
    },
  },
}));
