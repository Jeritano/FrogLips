import { test as base, expect, type Page } from "@playwright/test";

export { expect };

/* ── Mock surface exposed to tests via window.__mockTauri ── */

declare global {
  interface Window {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: {
      invoke: (cmd: string, args?: unknown, opts?: unknown) => Promise<unknown>;
      transformCallback: (cb: (msg: unknown) => void, once?: boolean) => number;
      unregisterCallback: (id: number) => void;
    };
    __TAURI_EVENT_PLUGIN_INTERNALS__?: {
      unregisterListener: (event: string, id: number) => void;
    };
    __TAURI_IPC__?: unknown;
    __mockTauri?: {
      invocations: Array<{ cmd: string; args: unknown }>;
      emit: (event: string, payload: unknown) => void;
      handlers: Record<string, (args: unknown) => unknown>;
    };
  }
}

/**
 * Install the Tauri runtime mock as an init script. Runs before any page JS,
 * so `import { invoke } from "@tauri-apps/api/core"` works without errors.
 *
 * Default handlers cover the happy-path commands surveyed in `src/lib/tauri-api.ts`
 * + the `plugin:window|*` / `plugin:event|*` plugin invocations triggered
 * during App startup. Tests can override per-command behaviour by calling
 * `await installTauriMock(page, { handlers: { my_cmd: () => ({...}) }})`.
 */
export interface MockOptions {
  handlers?: Record<string, (args: unknown) => unknown | Promise<unknown>>;
}

export async function installTauriMock(page: Page, opts: MockOptions = {}) {
  const overrideKeys = Object.keys(opts.handlers ?? {});
  await page.addInitScript(
    ({ overrideKeys: keys }) => {
      // Track invocations + per-command override registry. Tests set overrides
      // via window.__mockTauri.handlers post-load; the init script ships with
      // the keys reserved (values are filled in by the per-test seed script).
      const invocations: Array<{ cmd: string; args: unknown }> = [];
      const handlers: Record<string, (args: unknown) => unknown> = {};
      // Channel callback registry — Tauri uses numeric ids to route IPC msgs
      // back to JS callbacks. We just hold them and let tests fire them.
      const callbacks = new Map<number, (msg: unknown) => void>();
      let cbSeq = 1;
      // Event subscribers keyed by event name (plugin:event|listen wires here).
      const eventSubs = new Map<string, Set<number>>();

      function defaults(cmd: string, _args: unknown): unknown {
        switch (cmd) {
          /* — App boot — */
          case "settings_get":
            return {
              workspace_root: null,
              last_model: null,
              last_backend: null,
              memory_mode: "off",
              active_preset_id: "general",
              embedding_model: null,
              recall_threshold: 0.55,
              window: null,
              theme: "dark",
              custom_backends: [],
              mcp_servers: [],
            };
          case "settings_set":
            return {};
          case "server_status":
            return {
              running: true,
              ready: true,
              model: "mock-model",
              backend: "ollama",
              host: "127.0.0.1",
              port: 11434,
              last_error: null,
            };
          case "list_all_models":
            return { mlx: [], ollama: [{ id: "mock-model", size_bytes: 0, backend: "ollama" }] };
          case "list_conversations":
            return [];
          case "list_messages":
            return [];
          case "create_conversation":
            return 1;
          case "add_message":
            // monotonically increasing id is plenty for the tests
            return Math.floor(Date.now() % 1_000_000) + Math.floor(Math.random() * 1000);
          case "delete_conversation":
          case "rename_conversation":
          case "delete_message":
            return null;

          /* — First-run setup wizard — */
          case "setup_complete_get":
            // E2E suites assume a "returning user" — wizard already done —
            // unless a per-test handler overrides this to exercise the
            // first-run flow explicitly.
            return true;
          case "setup_complete_set":
            return null;

          /* — Memory — */
          case "list_memories":
            return [];
          case "search_memories_keyword":
          case "search_memories_vector":
            return [];
          case "find_duplicate_memory":
            return null;
          case "add_memory":
            return Math.floor(Math.random() * 1_000_000);
          case "delete_memory":
          case "update_memory_status":
          case "touch_memory":
          case "touch_memories":
            return null;

          /* — Agent workspace + classifiers — */
          case "agent_get_workspace":
            return null;
          case "agent_set_workspace":
            return null;
          case "agent_classify_shell":
            return "normal";
          case "agent_classify_applescript":
            return "normal";
          case "agent_classify_http":
            return "normal";

          /* — MCP — */
          case "mcp_list_servers":
            return [];
          case "mcp_list_tools":
            return [];

          /* — Native — */
          case "native_supported":
            return false;
          case "native_current_model":
            return null;

          /* — Window plugin (used by App.tsx geometry restore) — */
          case "plugin:window|inner_size":
            return { width: 1200, height: 800 };
          case "plugin:window|outer_position":
            return { x: 0, y: 0 };
          case "plugin:window|set_size":
          case "plugin:window|set_position":
            return null;
          case "plugin:window|scale_factor":
            return 1;

          /* — Event plugin — */
          case "plugin:event|listen": {
            const a = _args as { event?: string; handler?: number };
            if (a?.event && typeof a.handler === "number") {
              let set = eventSubs.get(a.event);
              if (!set) { set = new Set(); eventSubs.set(a.event, set); }
              set.add(a.handler);
            }
            // listen returns a numeric event id (used to unregister)
            return Math.floor(Math.random() * 1_000_000);
          }
          case "plugin:event|unlisten":
            return null;
          case "plugin:event|emit":
            return null;

          /* — Updater plugin (Check now) — */
          case "plugin:updater|check":
            return null;

          /* — Process plugin — */
          case "plugin:process|exit":
          case "plugin:process|relaunch":
            return null;

          default:
            return null;
        }
      }

      const internals = {
        // getCurrentWindow() reads `__TAURI_INTERNALS__.metadata.currentWindow.label`.
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        invoke(cmd: string, args?: unknown) {
          invocations.push({ cmd, args });
          const override = handlers[cmd];
          try {
            const out = override ? override(args) : defaults(cmd, args);
            return Promise.resolve(out);
          } catch (e) {
            return Promise.reject(e);
          }
        },
        transformCallback(cb: (msg: unknown) => void, _once?: boolean) {
          const id = cbSeq++;
          callbacks.set(id, cb);
          return id;
        },
        unregisterCallback(id: number) {
          callbacks.delete(id);
        },
      };

      // Expose
      (window as Window).__TAURI_INTERNALS__ = internals;
      (window as Window).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener(event: string, id: number) {
          eventSubs.get(event)?.delete(id);
        },
      };
      (window as Window).__TAURI__ = {};
      (window as Window).__mockTauri = {
        invocations,
        handlers,
        emit(event: string, payload: unknown) {
          const subs = eventSubs.get(event);
          if (!subs) return;
          for (const id of Array.from(subs)) {
            const cb = callbacks.get(id);
            cb?.({ event, id, payload });
          }
        },
      };

      // Reserve the override keys so per-test seed code can fill them in
      // synchronously without TS complaints (best-effort marker).
      for (const k of keys) handlers[k] = handlers[k] ?? (() => null);
    },
    { overrideKeys },
  );

  // Inject any per-test handler overrides as a follow-up init script so we
  // can pass real functions (the first script can't carry closures, but we
  // can stringify the body since handlers must be self-contained).
  if (opts.handlers) {
    for (const [cmd, fn] of Object.entries(opts.handlers)) {
      const body = fn.toString();
      await page.addInitScript(
        ({ cmd: c, body: b }) => {
          // Build the handler in page context. The function source must not
          // close over any test-scope variables.
          // eslint-disable-next-line @typescript-eslint/no-implied-eval
          const fn = new Function("return (" + b + ")")() as (a: unknown) => unknown;
          const m = (window as Window).__mockTauri;
          if (m) m.handlers[c] = fn;
        },
        { cmd, body },
      );
    }
  }
}

/* ── Page-side helpers (run inside the browser) ── */

export async function tauriInvocations(page: Page): Promise<Array<{ cmd: string; args: unknown }>> {
  return page.evaluate(() => (window as Window).__mockTauri?.invocations ?? []);
}

export async function emitTauriEvent(page: Page, event: string, payload: unknown) {
  await page.evaluate(({ event: e, payload: p }) => {
    (window as Window).__mockTauri?.emit(e, p);
  }, { event, payload });
}

export async function setMockHandler(
  page: Page,
  cmd: string,
  fn: (args: unknown) => unknown,
) {
  const body = fn.toString();
  await page.evaluate(({ cmd: c, body: b }) => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const handler = new Function("return (" + b + ")")() as (a: unknown) => unknown;
    const m = (window as Window).__mockTauri;
    if (m) m.handlers[c] = handler;
  }, { cmd, body });
}

/* ── Test fixture ── */

type Fixtures = {
  /**
   * Per-test handler overrides applied before navigation. Set via
   * `test.use({ tauriHandlers: { server_status: () => ({ running: false }) } })`.
   * Handler bodies must be self-contained — they're serialized to the page.
   */
  tauriHandlers: Record<string, (args: unknown) => unknown>;
};

export const test = base.extend<Fixtures>({
  tauriHandlers: [{}, { option: true }],
  page: async ({ page, tauriHandlers }, use) => {
    await installTauriMock(page, { handlers: tauriHandlers });
    await use(page);
  },
});
