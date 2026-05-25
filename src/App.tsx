import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "./lib/tauri-api";
import { configureMemory } from "./lib/memory-client";
import { logDiag } from "./lib/diagnostics";
import pkg from "../package.json";
import { useTwoClickConfirm } from "./lib/use-two-click-confirm";
import { useModalA11y } from "./lib/use-modal-a11y";
import { useTauriEvent } from "./hooks/useTauriEvent";
import { usePlatformChrome } from "./hooks/usePlatformChrome";
import { useWindowGeometry } from "./hooks/useWindowGeometry";
import { useImageGeneration } from "./hooks/useImageGeneration";
import type { ChatImage, Conversation, ImageMeta, ServerStatus } from "./types";
import { ModelPicker } from "./components/ModelPicker";
import { ChatWindow } from "./components/ChatWindow";
import { MemoryPanel } from "./components/MemoryPanel";
import { EmptyState } from "./components/EmptyState";
import { Toast } from "./components/Toast";
import { ErrorBar } from "./components/ErrorBar";
import { LiveRegion } from "./components/LiveRegion";
import { announce } from "./lib/announce";
import { parseTags, encodeTags, tagsFromInput } from "./lib/conversation-tags";
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
const AboutYouModal = lazy(() =>
  import("./components/AboutYouModal").then((m) => ({ default: m.AboutYouModal })),
);
// First-run-only flow: never seen by returning users, so it has no business
// living in the initial chunk. Mounts behind `wizardOpen === true`.
const SetupWizard = lazy(() =>
  import("./components/SetupWizard").then((m) => ({ default: m.SetupWizard })),
);
// Workflows canvas — React Flow + its CSS are heavy, so this stays in its own
// chunk that only fetches when the user opens the Workflows view.
const WorkflowsPage = lazy(() =>
  import("./components/workflows/WorkflowsPage").then((m) => ({ default: m.WorkflowsPage })),
);
// Image-generation surface — same lazy split as Workflows. The chunk only
// fetches when the user clicks the sidebar "Images" entry, so first paint
// stays unaffected.
const ImageView = lazy(() =>
  import("./components/ImageView").then((m) => ({ default: m.ImageView })),
);

function App() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [current, setCurrent] = useState<Conversation | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  // Conversation-id whose tag editor is open, plus its draft text.
  const [tagEditingId, setTagEditingId] = useState<number | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  // Content-search results: conversation ids whose messages match `convSearch`.
  // null = no content search performed (title-only filtering).
  const [contentMatchIds, setContentMatchIds] = useState<Set<number> | null>(null);
  // Pending soft-delete. We delay the destructive IPC call by 5s so the undo
  // toast can cancel it — this preserves the conversation AND its messages.
  const [pendingDelete, setPendingDelete] = useState<{
    conv: Conversation;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const [memoryTick, setMemoryTick] = useState(0);
  const [panelWorkspace, setPanelWorkspace] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [convSearch, setConvSearch] = useState("");
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [forkTreeOpen, setForkTreeOpen] = useState(false);
  const [memoriesOpen, setMemoriesOpen] = useState(false);
  const [aboutYouOpen, setAboutYouOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Main-pane view: chat / workflow canvas / image-gen surface.
  const [view, setView] = useState<"chat" | "workflows" | "images">("chat");
  // First-run setup wizard. `undefined` = haven't checked the flag yet, so we
  // render nothing for the wizard region until the IPC call returns. This
  // avoids a flash of the wizard on returning users whose setup is already
  // complete. Once we know, `true` mounts the wizard.
  const [wizardOpen, setWizardOpen] = useState<boolean | undefined>(undefined);
  const editInputRef = useRef<HTMLInputElement>(null);
  const memoriesModalRef = useRef<HTMLDivElement>(null);
  // Tauri 2 webview disables window.confirm — use an inline two-click pattern
  // for conversation deletion so accidental clicks don't nuke a thread.
  const deleteConfirm = useTwoClickConfirm();
  useModalA11y({
    open: memoriesOpen,
    onClose: () => setMemoriesOpen(false),
    containerRef: memoriesModalRef,
  });

  // Platform branding + macOS fullscreen tracking on <html>. `updateFullscreen`
  // is re-fired off the geometry event stream so the hamburger slide-over
  // follows the traffic lights disappearing in real time.
  const { updateFullscreen } = usePlatformChrome();
  useWindowGeometry(updateFullscreen);

  // Hoisted at App-level so the in-flight image-gen state + Tauri event
  // listeners survive a tab switch. Earlier this lived inside `ImageView`
  // and got torn down on view nav, which left a generate orphaned in Rust
  // while the UI forgot it was running. ImageView consumes via props.
  const imageGen = useImageGeneration();

  // Initial data + first-run wizard gate.
  useEffect(() => {
    // Window uses macOS Overlay title-bar style + hiddenTitle, so the OS
    // chrome only renders the traffic lights. `pkg` stays imported so the
    // version is available for the in-app footer.
    void pkg;
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
    // Configure the memory client + apply the persisted theme.
    api.settingsGet().then((s) => {
      configureMemory({
        embeddingModel: s.embedding_model,
        recallThreshold: s.recall_threshold,
      });
      if (s.theme === "light" || s.theme === "dark") {
        setTheme(s.theme);
        document.documentElement.dataset.theme = s.theme;
      }
    }).catch((err) =>
      logDiag({
        level: "warn",
        source: "app",
        message: "settingsGet() rejected on startup — memory client may use defaults",
        detail: err,
      }),
    );
  }, []);

  useTauriEvent<ServerStatus>(
    "server-status",
    useCallback((e) => setStatus(e.payload), []),
  );

  // Backend broadcasts this whenever a conversation's persisted state changes
  // (e.g. auto-titling on the first user message). Refresh the sidebar so the
  // derived title replaces the "New chat" placeholder without a manual reload.
  useTauriEvent<number>(
    "conversation-updated",
    useCallback(() => {
      refreshConversations().catch(() => {});
    }, []),
  );

  // Rust-side warnings: forward into the in-app diagnostics ring buffer so
  // MCP/RAG/agent failures surface in the panel alongside frontend diagnostics.
  useTauriEvent<{ level: "info" | "warn" | "error"; source: string; message: string; detail?: unknown }>(
    "app-diagnostics",
    useCallback((e) => {
      const p = e.payload;
      if (!p) return;
      logDiag({
        level: p.level === "error" || p.level === "warn" ? p.level : "info",
        source: typeof p.source === "string" ? p.source : "rust",
        message: typeof p.message === "string" ? p.message : "",
        detail: p.detail,
      });
    }, []),
  );

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
      // Don't hijack Cmd+N/L/K while the user is typing in a field — Cmd+N
      // inside the conv rename input or the workflow name input would
      // otherwise discard their edit by spawning a new chat. `select` is
      // intentionally NOT included (Cmd+K inside a model picker dropdown is
      // expected to do nothing — its focus shortcut is moot there anyway).
      // `isContentEditable` is the inherited property — a nested child of a
      // contenteditable root reports true, unlike `matches('[contenteditable]')`
      // which only catches the element with the attribute itself.
      const t = e.target as (Element | null);
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        (t instanceof HTMLElement && t.isContentEditable)
      ) {
        return;
      }
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

  // Debounced message-content search. Merges conversation ids whose message
  // bodies match into the title-only filter. Falls back gracefully if the
  // backend command is missing (older builds) — title search still works.
  useEffect(() => {
    const q = convSearch.trim();
    if (q.length < 2) {
      setContentMatchIds(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api.searchMessages(q)
        .then((hits) => {
          if (cancelled) return;
          setContentMatchIds(new Set(hits.map((h) => h.conversation_id)));
        })
        .catch((err) => {
          if (cancelled) return;
          setContentMatchIds(null);
          logDiag({
            level: "info",
            source: "app",
            message: "searchMessages failed — falling back to title-only search",
            detail: err,
          });
        });
    }, 220);
    return () => { cancelled = true; clearTimeout(t); };
  }, [convSearch]);

  // Cancel any in-flight soft-delete timer on unmount so it doesn't fire
  // against an unmounted tree.
  useEffect(() => {
    return () => {
      if (pendingDelete) clearTimeout(pendingDelete.timer);
    };
  }, [pendingDelete]);

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
    setView("chat");
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

  // Memoized so the downstream forest builder (orderedConversations) doesn't
  // rebuild on every unrelated state change. Recomputes only when the inputs
  // — the conversation list, the soft-delete target, the search query, or the
  // resolved content-match ids — actually change.
  const filteredConversations = useMemo(
    () =>
      conversations.filter((c) => {
        // Hide a conversation that is mid soft-delete so the row vanishes
        // while the undo toast is up; undo re-inserts it.
        if (pendingDelete && pendingDelete.conv.id === c.id) return false;
        const q = convSearch.trim().toLowerCase();
        if (!q) return true;
        // Title match OR message-content match (when content search resolved).
        return (
          c.title.toLowerCase().includes(q) ||
          (contentMatchIds !== null && contentMatchIds.has(c.id))
        );
      }),
    [conversations, pendingDelete, convSearch, contentMatchIds],
  );

  /**
   * Order conversations as a forest: each root is followed immediately by its
   * descendants (BFS-ordered) so the sidebar reads top-down as "root → branches".
   * Returns rows annotated with a depth count so the renderer can indent and
   * prefix children with `↳`. Cycle-safe via a visited set (paranoid — a
   * conversation cannot legally fork itself but bad data shouldn't lock the UI).
   */
  // Memoized — the forest walk is O(n) but was running on every render. Now
  // it only rebuilds when the filtered list actually changes.
  const orderedConversations = useMemo(() => {
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
  }, [filteredConversations]);

  // Soft-delete: hide the row immediately and schedule the destructive IPC
  // call 5s out. The undo toast cancels the timer, which restores the
  // conversation AND its messages intact (nothing was actually deleted yet).
  function deleteConv(id: number) {
    const conv = conversations.find((c) => c.id === id);
    if (!conv) return;
    // Commit any prior pending delete before starting a new one.
    if (pendingDelete) {
      clearTimeout(pendingDelete.timer);
      void commitDelete(pendingDelete.conv.id);
    }
    if (current?.id === id) setCurrent(null);
    const timer = setTimeout(() => {
      void commitDelete(id);
      setPendingDelete(null);
    }, 5000);
    setPendingDelete({ conv, timer });
    announce(`Conversation "${conv.title}" deleted. Undo available.`);
  }

  async function commitDelete(id: number) {
    try {
      await api.deleteConversation(id);
      await refreshConversations();
    } catch (e) {
      setErr(`Failed to delete conversation: ${e}`);
      await refreshConversations();
    }
  }

  function undoDelete() {
    if (!pendingDelete) return;
    clearTimeout(pendingDelete.timer);
    const restored = pendingDelete.conv;
    setPendingDelete(null);
    announce(`Conversation "${restored.title}" restored.`);
  }

  async function togglePin(c: Conversation, e: React.MouseEvent) {
    e.stopPropagation();
    const next = !c.pinned;
    // Optimistic update so the row reorders immediately.
    setConversations((prev) =>
      prev.map((x) => (x.id === c.id ? { ...x, pinned: next } : x)),
    );
    try {
      await api.setConversationPinned(c.id, next);
      announce(next ? `Pinned "${c.title}"` : `Unpinned "${c.title}"`);
      await refreshConversations();
    } catch (err) {
      setErr(`Failed to ${next ? "pin" : "unpin"} conversation: ${err}`);
      await refreshConversations();
    }
  }

  function startTagEdit(c: Conversation, e: React.MouseEvent) {
    e.stopPropagation();
    setTagEditingId(c.id);
    setTagDraft(parseTags(c.tags).join(", "));
  }

  async function commitTagEdit() {
    if (tagEditingId === null) return;
    const id = tagEditingId;
    const encoded = encodeTags(tagsFromInput(tagDraft));
    setTagEditingId(null);
    setTagDraft("");
    setConversations((prev) =>
      prev.map((x) => (x.id === id ? { ...x, tags: encoded } : x)),
    );
    try {
      await api.setConversationTags(id, encoded);
      await refreshConversations();
    } catch (err) {
      setErr(`Failed to update tags: ${err}`);
      await refreshConversations();
    }
  }

  function cancelTagEdit() {
    setTagEditingId(null);
    setTagDraft("");
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

  const onMemoriesChanged = useCallback(() => {
    setMemoryTick((t) => t + 1);
    announce("Memories updated");
  }, []);

  // Mirror error-bar text into the live region so screen-reader users hear
  // failures they'd otherwise only see.
  useEffect(() => {
    if (err) announce(`Error: ${err}`);
  }, [err]);

  // Send a generated image into the active (or a fresh) chat conversation as
  // a real user message. ChatImage requires the raw base64 payload — we don't
  // have a Rust read-file IPC we can use, so we pull the bytes through the
  // Tauri asset protocol (`convertFileSrc`) and base64-encode them in the
  // webview. If there's no active conversation we mint one first so the
  // "Send to chat" button is always meaningful from the Image view.
  const onSendImageToChat = useCallback(
    async (meta: ImageMeta) => {
      try {
        const url = convertFileSrc(meta.path);
        const resp = await fetch(url);
        if (!resp.ok) {
          throw new Error(`asset fetch ${resp.status}`);
        }
        const buf = await resp.arrayBuffer();
        // Chunked btoa — String.fromCharCode chokes on very large argument
        // counts (Safari historically capped around ~64k args). 4 MiB PNGs
        // can land here so we chunk to be safe.
        const bytes = new Uint8Array(buf);
        let binary = "";
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
        }
        const base64 = btoa(binary);
        const filename = meta.path.split("/").pop() || `image-${meta.id}.png`;
        const img: ChatImage = {
          base64,
          mime: "image/png",
          filename,
          size_bytes: bytes.length,
        };
        // Mint a conversation if there isn't one selected so the message has
        // a home. Reuses the same path ChatWindow takes for new chats.
        let convId = current?.id ?? null;
        if (convId == null) {
          convId = await api.createConversation("Image conversation", null);
          await refreshConversations();
          const all = await api.listConversations();
          const created = all.find((c) => c.id === convId) ?? null;
          if (created) setCurrent(created);
        }
        await api.addMessage(
          convId,
          "user",
          meta.prompt
            ? `Generated image — prompt: ${meta.prompt}`
            : `Generated image #${meta.id}`,
          null,
          [img],
        );
        // Drop the user into the chat surface so they see what just landed.
        setView("chat");
        announce("Image attached to chat");
      } catch (err) {
        logDiag({
          level: "warn",
          source: "app",
          message: "onSendImageToChat failed",
          detail: err,
        });
        setErr(`Could not attach image: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [current],
  );

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
    <div
      className="app"
      data-testid="app-ready"
      data-sidebar-collapsed={sidebarCollapsed ? "true" : undefined}
    >
      {/* Window drag strip — sits at the very top of the window, behind
          everything else (low z-index, pointer-events transparent except
          on this element). titleBarStyle: Overlay strips the OS drag bar
          so we provide one explicitly. */}
      <div className="window-drag-strip" data-tauri-drag-region />
      <aside className="sidebar">
        <div className="sidebar-top" data-tauri-drag-region>
          <div className="topbar-menu-wrap">
            <button
              type="button"
              className="topbar-btn topbar-hamburger"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Menu"
              onClick={() => setMenuOpen((v) => !v)}
              onBlur={() => setTimeout(() => setMenuOpen(false), 150)}
              title="Menu"
            >
              ☰
            </button>
            {menuOpen && (
              <div className="topbar-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  data-testid="open-dashboard"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { setDashboardOpen(true); setMenuOpen(false); }}
                >
                  <span aria-hidden="true">📊</span> Dashboard
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="menu-memories"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { setMemoriesOpen(true); setMenuOpen(false); }}
                >
                  <span aria-hidden="true">⭐</span> Memories
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="menu-about-you"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { setAboutYouOpen(true); setMenuOpen(false); }}
                >
                  <span aria-hidden="true">👤</span> About You
                </button>
                {current && (
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="menu-fork-tree"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { setForkTreeOpen(true); setMenuOpen(false); }}
                  >
                    <span aria-hidden="true">🌳</span> Branches
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  data-testid="menu-diagnostics"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { setDiagnosticsOpen(true); setMenuOpen(false); }}
                >
                  <span aria-hidden="true">🩺</span> Diagnostics
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="menu-rerun-wizard"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={async () => {
                    setMenuOpen(false);
                    try { await api.setupCompleteSet(false); } catch (err) {
                      logDiag({
                        level: "warn",
                        source: "app",
                        message: "setupCompleteSet(false) failed — wizard still opening locally",
                        detail: err,
                      });
                    }
                    setWizardOpen(true);
                  }}
                >
                  <span aria-hidden="true">🧭</span> Re-run setup wizard
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            className="topbar-btn topbar-collapse"
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-pressed={sidebarCollapsed}
            onClick={() => setSidebarCollapsed((v) => !v)}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <line x1="9" y1="4" x2="9" y2="20" />
            </svg>
          </button>
        </div>
        <div className="sidebar-spacer-top" aria-hidden="true" />
        {/* UI review U-C1: surface a small "Views" group label so the
            two top-level verbs (Workflows / Images) read as a navigation
            group rather than floating buttons. Chat is implicit — it's
            the substrate everything else lives in — so it doesn't get
            its own button (the locked layout reserves the + New chat
            button below for chat creation). */}
        <div className="sidebar-view-group" role="navigation" aria-label="App views">
          <div className="sidebar-section-label" aria-hidden="true">VIEWS</div>
          <button
            type="button"
            className="workflows-entry"
            onClick={() => setView("workflows")}
            // UI re-review M7: these are navigation targets, not toggles;
            // `aria-current="page"` is the semantically correct attribute.
            // Retain `aria-pressed` for compatibility with the existing
            // CSS selector — both set together.
            aria-current={view === "workflows" ? "page" : undefined}
            aria-pressed={view === "workflows"}
            data-testid="workflows-entry-btn"
          >
            <span aria-hidden="true">🧩</span> Workflows
          </button>
          <button
            type="button"
            className="images-entry"
            onClick={() => setView("images")}
            aria-current={view === "images" ? "page" : undefined}
            aria-pressed={view === "images"}
            data-testid="images-entry-btn"
          >
            <span aria-hidden="true">🎨</span> Images
            {/* UX re-review M5: dot indicator while image generation is
                in flight so a user who navigated away can see something
                is happening on a tab they're not currently viewing. */}
            {imageGen.running && (
              <span
                className="sidebar-activity-dot"
                aria-label="Image generation in progress"
                data-testid="images-entry-activity-dot"
              />
            )}
          </button>
        </div>
        <button className="new-chat" onClick={newChat} data-testid="new-chat-btn">+ New chat</button>
        <input
          className="conv-search"
          type="search"
          placeholder="Search conversations…"
          value={convSearch}
          onChange={(e) => setConvSearch(e.target.value)}
        />
        <ErrorBar message={err} onDismiss={() => setErr(null)} />

        <ul className="conv-list" data-testid="conv-list">
          {orderedConversations.length === 0 && (
            <li className="conv-list-empty" data-testid="conv-list-empty">
              {conversations.length === 0 ? (
                <EmptyState
                  icon="💬"
                  heading="No conversations yet"
                  sub="Start a new chat to begin — your threads will appear here."
                />
              ) : (
                <EmptyState
                  icon="🔎"
                  heading="No matches"
                  sub="No conversations match your search."
                />
              )}
            </li>
          )}
          {orderedConversations.map(({ conv: c, depth }) => {
            const tags = parseTags(c.tags);
            return (
            <li
              key={c.id}
              data-testid="conv-item"
              data-depth={depth}
              data-pinned={c.pinned ? "true" : undefined}
              className={`conv-row-anim${current?.id === c.id ? " active" : ""}`}
              onClick={() => {
                if (editingId === c.id || tagEditingId === c.id) return;
                setCurrent(c);
                setView("chat");
              }}
              onDoubleClick={(e) => startEdit(c, e)}
              title={depth > 0 ? "Branch — forked from another conversation" : "Double-click to rename"}
              style={depth > 0 ? { paddingLeft: 8 + Math.min(depth, 4) * 14 } : undefined}
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
                  <span className="conv-title-line">
                    {c.pinned && (
                      <span className="conv-pin-dot" aria-hidden="true" title="Pinned">📌</span>
                    )}
                    {depth > 0 && (
                      <span className="conv-branch-marker" aria-hidden="true">↳ </span>
                    )}
                    <span className="conv-title-text">{c.title}</span>
                  </span>
                  {tagEditingId === c.id ? (
                    <input
                      className="conv-tag-input"
                      value={tagDraft}
                      placeholder="tags, comma-separated"
                      onChange={(e) => setTagDraft(e.target.value)}
                      onBlur={commitTagEdit}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); commitTagEdit(); }
                        else if (e.key === "Escape") { e.preventDefault(); cancelTagEdit(); }
                      }}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                    />
                  ) : tags.length > 0 ? (
                    <span className="conv-tags" onClick={(e) => startTagEdit(c, e)} title="Edit tags">
                      {tags.map((t) => (
                        <span key={t} className="conv-tag-chip">{t}</span>
                      ))}
                    </span>
                  ) : null}
                </span>
              )}
              <button
                className="del conv-pin"
                title={c.pinned ? "Unpin conversation" : "Pin conversation"}
                aria-label={c.pinned ? "Unpin conversation" : "Pin conversation"}
                aria-pressed={!!c.pinned}
                data-testid="pin-conv"
                onClick={(e) => togglePin(c, e)}
              >
                {c.pinned ? "★" : "☆"}
              </button>
              <button
                className="del conv-tag-btn"
                title="Edit tags"
                aria-label="Edit conversation tags"
                data-testid="tag-conv"
                onClick={(e) => startTagEdit(c, e)}
              >
                🏷
              </button>
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
                className={`del${deleteConfirm.armed === String(c.id) ? " armed" : ""}`}
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
            );
          })}
        </ul>
        <div className="sidebar-spacer-bottom" aria-hidden="true" />
      </aside>
      <main className="main">
        <header>
          {view === "chat" && (
            <ModelPicker
              status={status}
              onStatusChange={setStatus}
              desiredModel={current?.model ?? null}
            />
          )}
          {/* UI review U-C2: previously the header collapsed to a single
              theme button on Workflows / Images. Users lost orientation
              when switching views. Render a view-title placeholder for
              non-chat views so the header always carries the active view
              name + theme control.

              For workflows, the page renders into `#workflow-topbar-slot`
              via createPortal so the editor controls (back button, name
              input, warnings) sit in the SAME header row as the chat
              ModelPicker. Without the slot, the workflows view used to
              show two stacked bars (global h1 + page-level wf-editor-bar)
              which read as visually heavier than chat's single-row header. */}
          {view === "workflows" && (
            <div
              id="workflow-topbar-slot"
              className="topbar-slot"
              data-testid="workflow-topbar-slot"
            />
          )}
          {view === "images" && (
            // UI re-review L3: label syncs with the sidebar entry. Was
            // "Image generation" in the header but "Images" in the
            // sidebar — pick one.
            <h1 className="topbar-view-title" data-testid="topbar-view-title">
              Images
            </h1>
          )}
          <button
            className="theme-toggle topbar-theme"
            onClick={toggleTheme}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            aria-label="Toggle theme"
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
        </header>
        {view === "workflows" ? (
          <Suspense fallback={null}>
            <WorkflowsPage status={status} />
          </Suspense>
        ) : view === "images" ? (
          <Suspense fallback={null}>
            <ImageView
              conversationId={current?.id ?? null}
              onSendToChat={onSendImageToChat}
              running={imageGen.running}
              progress={imageGen.progress}
              error={imageGen.error}
              generate={imageGen.generate}
            />
          </Suspense>
        ) : (
          <ChatWindow
            status={status}
            conversation={current}
            onConversationCreated={onConvCreated}
            onMemoriesChanged={onMemoriesChanged}
            onForked={onForked}
          />
        )}
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
      {memoriesOpen && (
        <div
          className="memories-overlay"
          onClick={(e) => { if (e.target === e.currentTarget) setMemoriesOpen(false); }}
          // WCAG 2.1 Level A: modal dialogs must close on Escape. Without this,
          // keyboard-only users had no way to dismiss the modal except by
          // tab-navigating to the × button.
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setMemoriesOpen(false);
            }
          }}
          role="dialog"
          aria-modal="true"
          aria-label="Memories"
          tabIndex={-1}
        >
          <div className="memories-modal" ref={memoriesModalRef}>
            <div className="memories-modal-header">
              <span>Memories</span>
              <button onClick={() => setMemoriesOpen(false)} aria-label="Close" className="memories-close">×</button>
            </div>
            <MemoryPanel
              refreshToken={memoryTick}
              workspaceRoot={panelWorkspace}
              conversationId={current?.id ?? null}
            />
          </div>
        </div>
      )}
      {aboutYouOpen && (
        <Suspense fallback={null}>
          <AboutYouModal onClose={() => setAboutYouOpen(false)} />
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
      {pendingDelete && (
        <Toast
          message={`Conversation "${pendingDelete.conv.title}" deleted`}
          actionLabel="Undo"
          onAction={undoDelete}
          onDismiss={() => {
            // Toast timed out / dismissed without undo — let the scheduled
            // delete run; nothing to do here. (The 5s soft-delete timer and
            // the toast both run ~5s, so this is just a safety net.)
            setPendingDelete((p) => {
              if (p) { clearTimeout(p.timer); void commitDelete(p.conv.id); }
              return null;
            });
          }}
          durationMs={5000}
        />
      )}
      <LiveRegion />
    </div>
  );
}

export default App;
