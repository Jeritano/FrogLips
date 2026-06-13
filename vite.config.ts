import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

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
  // Maturity review P1 #20: split the heavy markdown/syntax-highlight +
  // sanitization deps into their own "markdown" chunk so they're grouped
  // and cached together rather than scattered through the main chunk.
  // NOTE (perf #2, medium): markdown.ts is reached via a fully STATIC
  // import chain (App -> ChatWindow -> MessageList -> ../lib/markdown), so
  // this chunk is modulepreloaded and parsed on every launch — the split
  // does NOT defer it off first paint. Truly deferring it would require
  // lazy-loading MessageList/renderMarkdown (touches src/ component files,
  // out of scope here). React-flow IS genuinely deferred: its only
  // importer (WorkflowsPage) is React.lazy, so chat-only sessions never
  // download it.
  build: {
    // Audit M17 (2026-05-27): explicit chunk budget. Default warns at
    // 500 KB; we lower it to make accidental dep weight noisy at build
    // time. NOTE (cleanup #3, low): this is a soft, log-only warning —
    // it does NOT fail the build, and the main chunk currently builds
    // well over this limit, so the warning already fires on every build.
    // It is a tripwire, not an enforced gate. A real hard check (e.g. a
    // generateBundle hook with a committed bundle-budget) is intentionally
    // not wired here yet: enabling it now would fail the build until the
    // main chunk is trimmed back under budget.
    chunkSizeWarningLimit: 400,
    rollupOptions: {
      output: {
        // Perf review C6 + M27 (2026-06-09):
        // - The `reactflow: ["@xyflow/react"]` entry is GONE. The object-form
        //   manual chunk forced 189 KB of xyflow+d3 to fetch/parse/execute on
        //   every boot even though the only importer (WorkflowsPage) is
        //   React.lazy — Rollup now folds it into that async chunk, so
        //   chat-only sessions never load it.
        // - Function form for the markdown chunk: the old array form matched
        //   only the package ENTRY ids, so `highlight.js/lib/languages/*`
        //   subpath imports (64.5 KB of grammars in markdown.ts) leaked into
        //   the main chunk. Match by path so every hljs/marked/dompurify
        //   module lands in the markdown chunk together.
        // - Perf #1 (medium): katex (~270 KB) is statically imported by
        //   markdown.ts too, but was omitted here, so it folded into the
        //   main chunk. Route it to the markdown chunk so it travels with
        //   the renderer it belongs to instead of bloating the entry chunk.
        manualChunks(id: string) {
          if (
            id.includes("node_modules/highlight.js") ||
            id.includes("node_modules/marked") ||
            id.includes("node_modules/dompurify") ||
            id.includes("node_modules/katex")
          ) {
            return "markdown";
          }
        },
      },
    },
  },
}));
