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
  // sanitization deps into their own chunks. They're not on the cold-
  // start critical path (the empty chat shell renders before any
  // markdown ever needs to highlight), so isolating them lets the
  // main chunk land faster on first paint. React-flow is similarly
  // workflow-only — chunk it separately so chat-only sessions never
  // download it.
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          markdown: ["marked", "highlight.js", "dompurify"],
          reactflow: ["@xyflow/react"],
        },
      },
    },
  },
}));
