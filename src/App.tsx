import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "./lib/tauri-api";
import { applyAllAppearance, applyCodeTheme } from "./lib/appearance";
import { applyBubbleColor } from "./lib/bubble-color";
import { configureMemory } from "./lib/memory-client";
import { logDiag } from "./lib/diagnostics";
import pkg from "../package.json";
import { useModalA11y } from "./lib/use-modal-a11y";
import { useTauriEvent } from "./hooks/useTauriEvent";
import { useCommitOnUnmount } from "./hooks/useCommitOnUnmount";
import { usePlatformChrome } from "./hooks/usePlatformChrome";
import { useWindowGeometry } from "./hooks/useWindowGeometry";
import type { Conversation, ServerStatus } from "./types";
import { ModelPicker } from "./components/ModelPicker";
import { ChatWindow } from "./components/ChatWindow";
import { MemoryPanel } from "./components/MemoryPanel";
import { EmptyState } from "./components/EmptyState";
import { Toast } from "./components/Toast";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ErrorBar } from "./components/ErrorBar";
import { LiveRegion } from "./components/LiveRegion";
import { WorkflowRunProvider, useWorkflowRunControl } from "./lib/workflow/run-context";
import { RoundtableRunProvider, useRoundtableRun } from "./lib/roundtable/run-context";

type ViewId = "chat" | "workflows" | "knowledge" | "mcp" | "roundtable";

/**
 * Top-of-sidebar nav for the primary surfaces: Chat, Table
 * (Roundtable), Flows (Workflows), Tools (MCP). Per-tab activity dots
 * ride on the tab (workflow running, roundtable running) without
 * disturbing layout.
 *
 * Subscribes to `useWorkflowRunControl()` so the workflow-running dot
 * updates on run start/stop without re-rendering on every streamed
 * token (the per-card delta surface lives in a different context).
 * Audit H7 (2026-05-27).
 */
/** Top-level views, in sidebar nav order. */
const NAV_ITEMS: { id: ViewId; label: string; icon: string }[] = [
  { id: "chat", label: "Chat", icon: "💬" },
  { id: "roundtable", label: "Table", icon: "🎙️" },
  { id: "workflows", label: "Flows", icon: "⚡" },
  { id: "mcp", label: "Tools", icon: "🧰" },
];

/**
 * Stacked view-nav buttons at the top of the conversation sidebar — one
 * full-width button per view (icon + label). Replaced the horizontal
 * segmented control, which clipped once there were several views in the
 * ~210px strip. Activity dots surface in-progress workflow / roundtable
 * runs.
 */
function ViewNav({
  view,
  setView,
}: {
  view: ViewId;
  setView: (v: ViewId) => void;
}) {
  const { runningWorkflowId } = useWorkflowRunControl();
  const workflowsRunning = runningWorkflowId !== null;
  const { running: roundtableRunning } = useRoundtableRun();

  return (
    <div className="view-nav" role="tablist" aria-label="App views">
      {NAV_ITEMS.map((it) => {
        const active = view === it.id;
        const busy =
          (it.id === "workflows" && workflowsRunning) ||
          (it.id === "roundtable" && roundtableRunning);
        return (
          <button
            key={it.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={`view-nav-btn${active ? " active" : ""}`}
            onClick={() => setView(it.id)}
            data-testid={`view-tab-${it.id}`}
          >
            <span className="view-nav-icon" aria-hidden="true">{it.icon}</span>
            <span className="view-nav-label">{it.label}</span>
            {busy && <span className="view-nav-dot" />}
          </button>
        );
      })}
    </div>
  );
}
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
const AppearanceModal = lazy(() =>
  import("./components/AppearanceModal").then((m) => ({ default: m.AppearanceModal })),
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
// Knowledge surface — same lazy split as Workflows. The chunk only fetches
// when the user opens the Knowledge view, so first paint stays unaffected.
const KnowledgeView = lazy(() =>
  import("./components/KnowledgeView").then((m) => ({ default: m.KnowledgeView })),
);
const McpView = lazy(() =>
  import("./components/McpView").then((m) => ({ default: m.McpView })),
);
const RoundtableView = lazy(() =>
  import("./components/RoundtableView").then((m) => ({ default: m.RoundtableView })),
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
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Tracks the blur-close timeout so re-opening the menu within the delay
  // cancels the pending close (otherwise a stale timer snaps the just-reopened
  // menu shut).
  const menuCloseTimer = useRef<number | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Main-pane view: chat / workflow canvas / image-gen surface / knowledge library.
  const [view, setView] = useState<ViewId>("chat");
  // First-run setup wizard. `undefined` = haven't checked the flag yet, so we
  // render nothing for the wizard region until the IPC call returns. This
  // avoids a flash of the wizard on returning users whose setup is already
  // complete. Once we know, `true` mounts the wizard.
  const [wizardOpen, setWizardOpen] = useState<boolean | undefined>(undefined);
  const editInputRef = useRef<HTMLInputElement>(null);
  const memoriesModalRef = useRef<HTMLDivElement>(null);
  // Tauri 2 webview disables window.confirm — use an inline two-click pattern
  // for conversation deletion so accidental clicks don't nuke a thread.
  // Right-click context menu on a conversation row. Replaces the inline
  // pin/tag/detach/delete action chrome that previously hung on every
  // row — those buttons cost ~24px of vertical real-estate on each row
  // even when unused. UX refinement 2026-05-28. The two-click confirm
  // hook is no longer needed here because the existing soft-delete
  // toast (`pendingDelete`, 5s undo window) already provides the safety
  // net for accidental delete clicks.
  const [convContextMenu, setConvContextMenu] = useState<
    { conv: Conversation; x: number; y: number } | null
  >(null);
  // Viewport-clamped render position for the conversation context menu. The
  // raw click coords (convContextMenu.x/y) can put the menu off the right/
  // bottom edge; after it mounts we measure it and shift it back on-screen.
  const convMenuRef = useRef<HTMLDivElement>(null);
  const [convMenuPos, setConvMenuPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!convContextMenu) return;
    const el = convMenuRef.current;
    if (!el) return;
    const M = 8; // keep an 8px gutter from each edge
    const r = el.getBoundingClientRect();
    const left = Math.max(M, Math.min(convContextMenu.x, window.innerWidth - r.width - M));
    const top = Math.max(M, Math.min(convContextMenu.y, window.innerHeight - r.height - M));
    setConvMenuPos({ top, left });
  }, [convContextMenu]);
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

  // Initial data + first-run wizard gate.
  useEffect(() => {
    // Audit M-F4 (2026-05-28): React 18 StrictMode runs effects twice in
    // dev → two parallel settings reads. Without an `ignored` guard the
    // second read's resolution overwrites whatever state the first set,
    // and on a fresh install both could race setWizardOpen. Guard each
    // async branch so stale results from a prior mount drop silently.
    let ignored = false;
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
        if (ignored) return;
        if (done) { setWizardOpen(false); return; }
        if (s.last_model) {
          await api.setupCompleteSet(true).catch(() => {});
          if (ignored) return;
          setWizardOpen(false);
          return;
        }
        setWizardOpen(true);
      })
      .catch((err) => {
        if (ignored) return;
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
      if (ignored) return;
      configureMemory({
        embeddingModel: s.embedding_model,
        recallThreshold: s.recall_threshold,
      });
      if (s.theme === "light" || s.theme === "dark") {
        setTheme(s.theme);
        document.documentElement.dataset.theme = s.theme;
      }
      // Apply all device-local appearance prefs (per-theme code palettes,
      // code/interface fonts, transcript size, high-contrast) now that the
      // app theme is set, plus the chat-bubble color.
      applyAllAppearance();
      applyBubbleColor();
    }).catch((err) => {
      if (ignored) return;
      logDiag({
        level: "warn",
        source: "app",
        message: "settingsGet() rejected on startup — memory client may use defaults",
        detail: err,
      });
    });
    return () => {
      ignored = true;
    };
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

  // On unmount ONLY, commit any pending soft-delete (deleting then quitting
  // within the 5s undo window should honor the delete). The unmount-only
  // semantics live in `useCommitOnUnmount` — a naive `[pendingDelete]` dep
  // array would run the cleanup on every change and make Undo delete the row
  // it just restored (regression-tested in the hook). Round 12 (2026-05-30).
  useCommitOnUnmount(pendingDelete, (pd) => {
    clearTimeout(pd.timer);
    void api.deleteConversation(pd.conv.id).catch(() => {});
  });

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
    // Re-apply the code palette chosen for the NEW app theme (light/dark each
    // carry their own syntax-palette pick).
    applyCodeTheme(next);
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
      // C8: functional update keyed on the CURRENT selection, not the `current`
      // captured when commitEdit was invoked. Between the await above and here
      // the user may have switched conversations; writing back the stale
      // `current` would clobber the new selection. Only rewrite the title if
      // `prev` is still the conversation we renamed.
      setCurrent((prev) => (prev && prev.id === id ? { ...prev, title } : prev));
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
              onClick={() => {
                if (menuCloseTimer.current != null) {
                  clearTimeout(menuCloseTimer.current);
                  menuCloseTimer.current = null;
                }
                setMenuOpen((v) => !v);
              }}
              onBlur={() => {
                if (menuCloseTimer.current != null) clearTimeout(menuCloseTimer.current);
                menuCloseTimer.current = window.setTimeout(() => {
                  setMenuOpen(false);
                  menuCloseTimer.current = null;
                }, 150);
              }}
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
                <button
                  type="button"
                  role="menuitem"
                  data-testid="menu-appearance"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { setAppearanceOpen(true); setMenuOpen(false); }}
                >
                  <span aria-hidden="true">🎨</span> Appearance
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
                  data-testid="menu-knowledge"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { setView("knowledge"); setMenuOpen(false); }}
                >
                  <span aria-hidden="true">📚</span> Knowledge
                </button>
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
        {/* Stacked view-nav buttons (one per view). Knowledge stays in the
            hamburger menu (less-frequent editorial surface). */}
        <ViewNav view={view} setView={setView} />
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
              onContextMenu={(e) => {
                if (editingId === c.id || tagEditingId === c.id) return;
                e.preventDefault();
                e.stopPropagation();
                setConvMenuPos(null);
                setConvContextMenu({ conv: c, x: e.clientX, y: e.clientY });
              }}
              title={depth > 0 ? "Branch — forked from another conversation" : "Right-click for actions; double-click to rename"}
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
              {/* Action chrome (pin / tags / detach / delete) now lives in
                  the right-click context menu rendered below the list. The
                  pinned `📌` glyph still appears as a left-side indicator
                  inside `.conv-title-line` for at-a-glance state. */}
            </li>
            );
          })}
        </ul>
        {convContextMenu && (
          <>
            {/* Click-anywhere backdrop closes the menu. Transparent + full-
                screen + high z so an outside click anywhere on the app
                dismisses without needing a per-element listener. */}
            <div
              className="conv-context-backdrop"
              data-testid="conv-context-backdrop"
              onClick={() => setConvContextMenu(null)}
              onContextMenu={(e) => {
                // Right-clicking the backdrop also closes the menu;
                // preventDefault stops the browser's own menu from
                // popping up on top of ours.
                e.preventDefault();
                setConvContextMenu(null);
              }}
            />
            <div
              ref={convMenuRef}
              className="conv-context-menu"
              role="menu"
              data-testid="conv-context-menu"
              style={{
                top: convMenuPos?.top ?? convContextMenu.y,
                left: convMenuPos?.left ?? convContextMenu.x,
                // Hide the pre-measure frame so the menu never flashes at the
                // raw (possibly off-screen) click point before clamping.
                visibility: convMenuPos ? "visible" : "hidden",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                role="menuitem"
                data-testid="ctx-pin"
                onClick={(e) => {
                  void togglePin(convContextMenu.conv, e);
                  setConvContextMenu(null);
                }}
              >
                {convContextMenu.conv.pinned ? "📌 Unpin" : "📌 Pin"}
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="ctx-tag"
                onClick={(e) => {
                  startTagEdit(convContextMenu.conv, e);
                  setConvContextMenu(null);
                }}
              >
                🏷 Edit tags…
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="ctx-detach"
                onClick={(e) => {
                  e.stopPropagation();
                  const conv = convContextMenu.conv;
                  // Fire-and-forget; the Rust side focuses an existing
                  // window when one already exists for this conv id.
                  api.openConversationWindow(conv.id, conv.title).catch((err) => {
                    setErr(`Failed to open window: ${err}`);
                  });
                  setConvContextMenu(null);
                }}
              >
                ⧉ Open in new window
              </button>
              <div className="conv-context-divider" role="separator" />
              <button
                type="button"
                role="menuitem"
                data-testid="ctx-delete"
                className="conv-context-danger"
                onClick={(e) => {
                  e.stopPropagation();
                  // deleteConv handles the soft-delete + 5s undo toast
                  // already in `pendingDelete`, so a single confirm
                  // here is enough — no two-click arming needed.
                  void deleteConv(convContextMenu.conv.id);
                  setConvContextMenu(null);
                }}
              >
                🗑 Delete
              </button>
            </div>
          </>
        )}
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
              theme button on non-chat views (Flows / Tools). Users lost
              orientation when switching views. Render a view-title
              placeholder for non-chat views so the header always carries
              the active view name + theme control.

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
          {/* Tools view portals its tabs + "Add manually" here so they share
              this header row with the theme toggle (no second stacked bar). */}
          {view === "mcp" && (
            <div
              id="mcp-topbar-slot"
              className="topbar-slot"
              data-testid="mcp-topbar-slot"
            />
          )}
          {/* Roundtable view portals its title + presets/Reset (or live
              meter/actions) here so they share the theme-toggle's row. */}
          {view === "roundtable" && (
            <div
              id="roundtable-topbar-slot"
              className="topbar-slot"
              data-testid="roundtable-topbar-slot"
            />
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
        {/* Audit LOW (2026-05-27): per-view ErrorBoundary so a render
            crash inside one view doesn't blank the sidebar — the user
            needs the sidebar to switch away from the crashed view. The
            root-level ErrorBoundary in main.tsx still catches anything
            that escapes these (e.g. crash inside the header itself). */}
        {view === "workflows" ? (
          <ErrorBoundary label="Workflows">
            <Suspense fallback={null}>
              <WorkflowsPage status={status} />
            </Suspense>
          </ErrorBoundary>
        ) : view === "knowledge" ? (
          <ErrorBoundary label="Knowledge">
            <Suspense fallback={null}>
              <KnowledgeView />
            </Suspense>
          </ErrorBoundary>
        ) : view === "mcp" ? (
          <ErrorBoundary label="Tools">
            <Suspense fallback={null}>
              <McpView />
            </Suspense>
          </ErrorBoundary>
        ) : view === "roundtable" ? (
          <ErrorBoundary label="Roundtable">
            <Suspense fallback={null}>
              <RoundtableView />
            </Suspense>
          </ErrorBoundary>
        ) : (
          <ErrorBoundary label="Chat">
            <ChatWindow
              status={status}
              conversation={current}
              onConversationCreated={onConvCreated}
              onMemoriesChanged={onMemoriesChanged}
              onForked={onForked}
            />
          </ErrorBoundary>
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
      {appearanceOpen && (
        <Suspense fallback={null}>
          <AppearanceModal
            open={appearanceOpen}
            onClose={() => setAppearanceOpen(false)}
            theme={theme}
            onToggleTheme={toggleTheme}
          />
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

/**
 * Root export wraps `<App>` with the workflow-run provider so workflow
 * runs survive page navigation. The provider owns the AbortController
 * and per-card live state; `<WorkflowsPage>` consumes via
 * `useWorkflowRun()`. Unmounting WorkflowsPage no longer cancels a
 * running workflow — only an App-level remount (full reload) does.
 *
 * `<App>` itself can call `useWorkflowRun()` because it renders below
 * the provider; the small sidebar "● running" badge that points users
 * back to a live workflow run is the planned consumer.
 */
function AppWithProviders() {
  return (
    <WorkflowRunProvider>
      <RoundtableRunProvider>
        <App />
      </RoundtableRunProvider>
    </WorkflowRunProvider>
  );
}

export default AppWithProviders;
// Named export kept for tests that import the inner component directly.
export { App };
