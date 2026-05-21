import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { api } from "./lib/tauri-api";
import { configureMemory } from "./lib/memory-client";
import { logDiag } from "./lib/diagnostics";
import { useTwoClickConfirm } from "./lib/use-two-click-confirm";
import type { Conversation, ServerStatus } from "./types";
import { ModelPicker } from "./components/ModelPicker";
import { ChatWindow } from "./components/ChatWindow";
import { MemoryPanel } from "./components/MemoryPanel";
import "./App.css";

// Heavy panels that aren't needed for first paint: lazy-load so they ship in
// their own chunks. Each is gated behind a user action (sidebar button / fork
// gesture), so the small extra latency on first open is invisible against the
// network/disk fetch they trigger anyway.
const Dashboard = lazy(() =>
  import("./components/Dashboard").then((m) => ({ default: m.Dashboard })),
);
const DiagnosticsPanel = lazy(() =>
  import("./components/DiagnosticsPanel").then((m) => ({ default: m.DiagnosticsPanel })),
);
const ForkTreeModal = lazy(() =>
  import("./components/ForkTree").then((m) => ({ default: m.ForkTreeModal })),
);
// First-run-only flow: never seen by returning users, so it has no business
// living in the initial chunk. Mounts behind `wizardOpen === true`.
const SetupWizard = lazy(() =>
  import("./components/SetupWizard").then((m) => ({ default: m.SetupWizard })),
);

function App() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [current, setCurrent] = useState<Conversation | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [memoryTick, setMemoryTick] = useState(0);
  const [panelWorkspace, setPanelWorkspace] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [convSearch, setConvSearch] = useState("");
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [forkTreeOpen, setForkTreeOpen] = useState(false);
  // First-run setup wizard. `undefined` = haven't checked the flag yet, so we
  // render nothing for the wizard region until the IPC call returns. This
  // avoids a flash of the wizard on returning users whose setup is already
  // complete. Once we know, `true` mounts the wizard.
  const [wizardOpen, setWizardOpen] = useState<boolean | undefined>(undefined);
  const editInputRef = useRef<HTMLInputElement>(null);
  // Tauri 2 webview disables window.confirm — use an inline two-click pattern
  // for conversation deletion so accidental clicks don't nuke a thread.
  const deleteConfirm = useTwoClickConfirm();

  useEffect(() => {
    refreshStatus();
    refreshConversations();
    // First-run gate: ask Rust whether the wizard has been completed before.
    // Defaults to opening the wizard if the IPC call rejects — better to over-
    // show the wizard than to leave a new user staring at a blank app.
    // Heuristic: if setup_complete is unset BUT the user has a last_model
    // already picked, this is an existing install that pre-dates the wizard.
    // Auto-mark them complete so the wizard never opens.
    Promise.all([api.setupCompleteGet(), api.settingsGet()])
      .then(async ([done, s]) => {
        if (done) { setWizardOpen(false); return; }
        if (s.last_model) {
          await api.setupCompleteSet(true).catch(() => {});
          setWizardOpen(false);
          return;
        }
        setWizardOpen(true);
      })
      .catch((err) => {
        logDiag({
          level: "info",
          source: "app",
          message: "setupCompleteGet/settingsGet rejected — defaulting to showing the wizard",
          detail: err,
        });
        setWizardOpen(true);
      });
    // Load settings + restore window geometry + configure memory client
    api.settingsGet().then(async (s) => {
      configureMemory({
        embeddingModel: s.embedding_model,
        recallThreshold: s.recall_threshold,
      });
      if (s.theme === "light" || s.theme === "dark") {
        setTheme(s.theme);
        document.documentElement.dataset.theme = s.theme;
      }
      const win = getCurrentWindow();
      if (s.window) {
        try {
          if (s.window.width > 200 && s.window.height > 200) {
            await win.setSize(new PhysicalSize(Math.round(s.window.width), Math.round(s.window.height)));
          }
          if (s.window.x != null && s.window.y != null) {
            await win.setPosition(new PhysicalPosition(Math.round(s.window.x), Math.round(s.window.y)));
          }
        } catch (err) {
          logDiag({
            level: "warn",
            source: "app",
            message: "restoring window geometry failed",
            detail: err,
          });
        }
      }
    }).catch((err) =>
      logDiag({
        level: "warn",
        source: "app",
        message: "settingsGet() rejected on startup — memory client may use defaults",
        detail: err,
      }),
    );

    // Persist window geometry on resize/move with debounce
    let saveTimer: number | undefined;
    const win = getCurrentWindow();
    const persistGeometry = () => {
      if (saveTimer) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(async () => {
        try {
          const sz = await win.innerSize();
          const pos = await win.outerPosition();
          await api.settingsSet({
            window: { width: sz.width, height: sz.height, x: pos.x, y: pos.y },
          });
        } catch (err) {
          logDiag({
            level: "warn",
            source: "app",
            message: "persistGeometry: settingsSet failed",
            detail: err,
          });
        }
      }, 500);
    };
    const offResize = win.onResized(persistGeometry);
    const offMove = win.onMoved(persistGeometry);

    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    let unlistenDiag: UnlistenFn | undefined;
    listen<ServerStatus>("server-status", (e) => setStatus(e.payload))
      .then((fn) => {
        if (cancelled) { fn(); } else { unlisten = fn; }
      })
      .catch((err) =>
        logDiag({
          level: "warn",
          source: "app",
          message: "server-status event listener failed to register — relying on manual refresh",
          detail: err,
        }),
      );

    // Rust-side warnings: forward into the in-app diagnostics ring buffer
    // so MCP/RAG/agent failures surface in the panel alongside frontend
    // diagnostics. Payload shape mirrors `Omit<DiagEntry, "ts">`.
    listen<{ level: "info" | "warn" | "error"; source: string; message: string; detail?: unknown }>(
      "app-diagnostics",
      (e) => {
        const p = e.payload;
        if (!p) return;
        logDiag({
          level: p.level === "error" || p.level === "warn" ? p.level : "info",
          source: typeof p.source === "string" ? p.source : "rust",
          message: typeof p.message === "string" ? p.message : "",
          detail: p.detail,
        });
      },
    )
      .then((fn) => {
        if (cancelled) { fn(); } else { unlistenDiag = fn; }
      })
      .catch((err) =>
        logDiag({
          level: "warn",
          source: "app",
          message: "app-diagnostics event listener failed to register — Rust warnings not visible",
          detail: err,
        }),
      );

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      if (unlistenDiag) unlistenDiag();
      offResize.then((f) => f()).catch((err) =>
        logDiag({
          level: "info",
          source: "app",
          message: "offResize cleanup rejected",
          detail: err,
        }),
      );
      offMove.then((f) => f()).catch((err) =>
        logDiag({
          level: "info",
          source: "app",
          message: "offMove cleanup rejected",
          detail: err,
        }),
      );
      if (saveTimer) window.clearTimeout(saveTimer);
    };
  }, []);

  // Track the agent workspace root so MemoryPanel can bind newly-created
  // project-scoped memories without re-asking the user. Refetched on every
  // memoryTick (covers workspace changes from inside ChatWindow) and on
  // conversation switch (cheap; just reads in-memory state on the Rust side).
  useEffect(() => {
    let cancelled = false;
    api.agentGetWorkspace().then((p) => {
      if (!cancelled) setPanelWorkspace(p ?? null);
    }).catch((err) =>
      logDiag({
        level: "warn",
        source: "app",
        message: "agentGetWorkspace failed — MemoryPanel will fall back to global scope",
        detail: err,
      }),
    );
    return () => { cancelled = true; };
  }, [memoryTick, current?.id]);

  // Global keyboard shortcuts: Cmd+N new chat, Cmd+L library, Cmd+K model picker focus
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key === "n") { e.preventDefault(); newChat(); return; }
      if (key === "l") {
        e.preventDefault();
        // Click the Browse & download models option in picker
        const lib = document.querySelector<HTMLButtonElement>("[data-shortcut='open-library']");
        lib?.click();
        return;
      }
      if (key === "k") {
        e.preventDefault();
        const sel = document.querySelector<HTMLElement>("[data-shortcut='focus-model']");
        sel?.focus();
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (editingId !== null) editInputRef.current?.select();
  }, [editingId]);

  async function refreshStatus() {
    try {
      setStatus(await api.serverStatus());
    } catch (err) {
      logDiag({
        level: "warn",
        source: "app",
        message: "refreshStatus: serverStatus() failed",
        detail: err,
      });
    }
  }

  async function refreshConversations() {
    try {
      setConversations(await api.listConversations());
    } catch (err) {
      logDiag({
        level: "warn",
        source: "app",
        message: "refreshConversations: listConversations() failed",
        detail: err,
      });
    }
  }

  function newChat() {
    setCurrent(null);
  }

  function toggleTheme() {
    const next: "dark" | "light" = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    api.settingsSet({ theme: next }).catch((err) =>
      logDiag({
        level: "warn",
        source: "app",
        message: "settingsSet(theme) failed — UI updated but not persisted",
        detail: err,
      }),
    );
  }

  const filteredConversations = conversations.filter((c) =>
    !convSearch.trim() || c.title.toLowerCase().includes(convSearch.trim().toLowerCase()),
  );

  /**
   * Order conversations as a forest: each root is followed immediately by its
   * descendants (BFS-ordered) so the sidebar reads top-down as "root → branches".
   * Returns rows annotated with a depth count so the renderer can indent and
   * prefix children with `↳`. Cycle-safe via a visited set (paranoid — a
   * conversation cannot legally fork itself but bad data shouldn't lock the UI).
   */
  const orderedConversations = (() => {
    const byParent = new Map<number | null, Conversation[]>();
    for (const c of filteredConversations) {
      const parent = c.parent_conv_id ?? null;
      const arr = byParent.get(parent) ?? [];
      arr.push(c);
      byParent.set(parent, arr);
    }
    const knownIds = new Set(filteredConversations.map((c) => c.id));
    // A conv is a "root" for sidebar purposes if its parent isn't in the
    // currently-visible (search-filtered) list — that way filtered children
    // still appear at depth 0 rather than vanishing.
    const roots = filteredConversations.filter((c) =>
      c.parent_conv_id == null || !knownIds.has(c.parent_conv_id),
    );
    const out: { conv: Conversation; depth: number }[] = [];
    const visited = new Set<number>();
    const walk = (c: Conversation, depth: number) => {
      if (visited.has(c.id)) return;
      visited.add(c.id);
      out.push({ conv: c, depth });
      const kids = byParent.get(c.id) ?? [];
      for (const k of kids) walk(k, depth + 1);
    };
    for (const r of roots) walk(r, 0);
    // Any orphan that didn't get walked (shouldn't happen, but…) — append.
    for (const c of filteredConversations) {
      if (!visited.has(c.id)) out.push({ conv: c, depth: 0 });
    }
    return out;
  })();

  async function deleteConv(id: number) {
    try {
      await api.deleteConversation(id);
      if (current?.id === id) setCurrent(null);
      await refreshConversations();
    } catch (e) {
      setErr(`Failed to delete conversation: ${e}`);
      await refreshConversations();
    }
  }

  function startEdit(c: Conversation, e: React.MouseEvent) {
    e.stopPropagation();
    setEditingId(c.id);
    setEditingTitle(c.title);
  }

  async function commitEdit() {
    if (editingId === null) return;
    const id = editingId;
    const title = editingTitle.trim();
    setEditingId(null);
    if (!title) return;
    const original = conversations.find((c) => c.id === id);
    if (original && original.title === title) return;
    try {
      await api.renameConversation(id, title);
      if (current?.id === id) setCurrent({ ...current, title });
      await refreshConversations();
    } catch (e) {
      setErr(`Rename failed: ${e}`);
      await refreshConversations();
    }
  }

  function cancelEdit() {
    setEditingId(null);
    setEditingTitle("");
  }

  // Stable ChatWindow callbacks — inline arrow handlers caused MessageRow
  // (React.memo) to bust on every parent render, which during streaming
  // produced one re-render per rAF frame.
  const onConvCreated = useCallback((c: Conversation) => {
    setCurrent(c);
    refreshConversations().catch((err) =>
      logDiag({
        level: "warn",
        source: "app",
        message: "post-create refreshConversations failed",
        detail: err,
      }),
    );
  }, []);

  const onMemoriesChanged = useCallback(() => setMemoryTick((t) => t + 1), []);

  const onForked = useCallback(async (newConvId: number) => {
    await refreshConversations();
    try {
      const all = await api.listConversations();
      const created = all.find((c) => c.id === newConvId);
      if (created) setCurrent(created);
    } catch (err) {
      logDiag({
        level: "info",
        source: "app",
        message: "onForked: listConversations after fork failed — sidebar still reflects the new conv",
        detail: err,
      });
    }
  }, []);

  return (
    <div className="app" data-testid="app-ready">
      <aside className="sidebar">
        <div className="sidebar-top">
          <button className="new-chat" onClick={newChat} data-testid="new-chat-btn">+ New chat</button>
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            aria-label="Toggle theme"
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
        </div>
        <input
          className="conv-search"
          type="search"
          placeholder="Search conversations…"
          value={convSearch}
          onChange={(e) => setConvSearch(e.target.value)}
        />
        {err && (
          <div className="error-bar" onClick={() => setErr(null)} title="Click to dismiss">
            {err}
          </div>
        )}
        <ul className="conv-list" data-testid="conv-list">
          {orderedConversations.map(({ conv: c, depth }) => (
            <li
              key={c.id}
              data-testid="conv-item"
              data-depth={depth}
              className={current?.id === c.id ? "active" : ""}
              onClick={() => editingId !== c.id && setCurrent(c)}
              onDoubleClick={(e) => startEdit(c, e)}
              title={depth > 0 ? "Branch — forked from another conversation" : "Double-click to rename"}
              style={depth > 0 ? { paddingLeft: 8 + depth * 14 } : undefined}
            >
              {editingId === c.id ? (
                <input
                  ref={editInputRef}
                  className="conv-rename"
                  value={editingTitle}
                  onChange={(e) => setEditingTitle(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); commitEdit(); }
                    else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  autoFocus
                />
              ) : (
                <span className="conv-title">
                  {depth > 0 && (
                    <span className="conv-branch-marker" aria-hidden="true">↳ </span>
                  )}
                  {c.title}
                </span>
              )}
              <button
                className="del detach"
                title="Open in a new window"
                aria-label="Detach into new window"
                data-testid="detach-conv"
                onClick={(e) => {
                  e.stopPropagation();
                  // Fire-and-forget; the Rust side focuses an existing
                  // window when one already exists for this conv id.
                  api.openConversationWindow(c.id, c.title).catch((err) => {
                    setErr(`Failed to open window: ${err}`);
                  });
                }}
              >
                ⧉
              </button>
              <button
                className="del"
                title={
                  deleteConfirm.armed === String(c.id)
                    ? "Click again to confirm deletion"
                    : "Delete"
                }
                aria-label={
                  deleteConfirm.armed === String(c.id)
                    ? "Click again to confirm deletion"
                    : "Delete conversation"
                }
                onClick={(e) => {
                  e.stopPropagation();
                  deleteConfirm.request(String(c.id), () => {
                    void deleteConv(c.id);
                  });
                }}
              >
                {deleteConfirm.labelFor(String(c.id), "×")}
              </button>
            </li>
          ))}
        </ul>
        <MemoryPanel
          refreshToken={memoryTick}
          workspaceRoot={panelWorkspace}
          conversationId={current?.id ?? null}
        />
        <button
          type="button"
          className="dashboard-btn"
          data-testid="open-dashboard"
          onClick={() => setDashboardOpen(true)}
          title="Open usage dashboard"
        >
          <span aria-hidden="true">📊</span>
          Dashboard
        </button>
        <button
          type="button"
          className="dashboard-btn"
          data-testid="open-diagnostics"
          onClick={() => setDiagnosticsOpen(true)}
          title="Open diagnostics panel (silent errors, MCP/RAG/agent warnings)"
        >
          <span aria-hidden="true">🩺</span>
          Diagnostics
        </button>
        <button
          type="button"
          className="dashboard-btn"
          data-testid="rerun-setup-wizard"
          onClick={async () => {
            // Flip the persistent flag back to "incomplete" and re-mount the
            // wizard. We persist first so a crash mid-wizard still re-opens
            // it on next launch (same behavior as a brand-new install).
            try {
              await api.setupCompleteSet(false);
            } catch (err) {
              logDiag({
                level: "warn",
                source: "app",
                message: "setupCompleteSet(false) failed — wizard still opening locally",
                detail: err,
              });
            }
            setWizardOpen(true);
          }}
          title="Re-open the first-run setup wizard"
        >
          <span aria-hidden="true">🧭</span>
          Re-run setup wizard
        </button>
        {current && (
          <button
            type="button"
            className="dashboard-btn"
            data-testid="open-fork-tree"
            onClick={() => setForkTreeOpen(true)}
            title="Visualize the fork tree rooted at the current conversation"
          >
            <span aria-hidden="true">🌳</span>
            Branches
          </button>
        )}
      </aside>
      <main className="main">
        <header>
          <ModelPicker status={status} onStatusChange={setStatus} />
        </header>
        <ChatWindow
          status={status}
          conversation={current}
          onConversationCreated={onConvCreated}
          onMemoriesChanged={onMemoriesChanged}
          onForked={onForked}
        />
      </main>
      {/*
       * Mount lazy panels only while open so their chunks don't fetch on
       * startup. Suspense fallback is intentionally null — these panels are
       * modal overlays, so any transient spinner would flash above the chat
       * for a few ms before the chunk resolves. The buttons are already in
       * their pressed state, which is enough feedback.
       */}
      {dashboardOpen && (
        <Suspense fallback={null}>
          <Dashboard open={dashboardOpen} onClose={() => setDashboardOpen(false)} />
        </Suspense>
      )}
      {diagnosticsOpen && (
        <Suspense fallback={null}>
          <DiagnosticsPanel open={diagnosticsOpen} onClose={() => setDiagnosticsOpen(false)} />
        </Suspense>
      )}
      {forkTreeOpen && (
        <Suspense fallback={null}>
          <ForkTreeModal
            open={forkTreeOpen}
            onClose={() => setForkTreeOpen(false)}
            rootId={current?.id ?? null}
            onSelect={(id) => {
              const c = conversations.find((x) => x.id === id);
              if (c) setCurrent(c);
              setForkTreeOpen(false);
            }}
          />
        </Suspense>
      )}
      {wizardOpen === true && (
        <Suspense fallback={null}>
          <SetupWizard
            onDone={async (samplePrompt) => {
            // Persist the wizard-complete flag so the next launch lands the
            // user straight in the chat. We do this even on the "Skip setup"
            // path — the user has explicitly opted out, so don't nag again.
            try {
              await api.setupCompleteSet(true);
            } catch (err) {
              logDiag({
                level: "warn",
                source: "app",
                message: "setupCompleteSet(true) failed — wizard will reopen on next launch",
                detail: err,
              });
            }
            setWizardOpen(false);
            if (samplePrompt) {
              // Defer until the wizard has fully unmounted so ChatInput is
              // mounted and listening. The composer focuses + selects on
              // prefill internally.
              setTimeout(() => {
                window.dispatchEvent(
                  new CustomEvent("chat-input:prefill", {
                    detail: { text: samplePrompt },
                  }),
                );
              }, 0);
            }
          }}
        />
        </Suspense>
      )}
    </div>
  );
}

export default App;
