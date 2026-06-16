import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  MessageSquare,
  Users,
  Zap,
  Wrench,
  Blocks,
  BarChart3,
  Star,
  User,
  Image as ImageIcon,
  GitBranch,
  Tag,
  Trash2,
  Search,
  X,
  Menu,
  BookOpen,
  ShieldCheck,
  Stethoscope,
  Compass,
  Pin,
  ExternalLink,
  Sun,
  Moon,
  AlertTriangle,
} from "lucide-react";
import { Kbd } from "./components/ui";
import {
  CommandPalette,
  paletteIcons,
  type PaletteAction,
} from "./components/CommandPalette";
import { FirstRunTour, startFirstRunTour } from "./components/FirstRunTour";
import { api } from "./lib/tauri-api";
import { applyAllAppearance } from "./lib/appearance";
import { applyBubbleColor } from "./lib/bubble-color";
import { configureMemory } from "./lib/memory-client";
import { logDiag } from "./lib/diagnostics";
import pkg from "../package.json";
import { useModalA11y } from "./lib/use-modal-a11y";
import { useTauriEvent } from "./hooks/useTauriEvent";
import { useUpdateCheck } from "./hooks/useUpdateCheck";
import { usePlatformChrome } from "./hooks/usePlatformChrome";
import { useWindowGeometry } from "./hooks/useWindowGeometry";
import { useRamPressure } from "./hooks/useRamPressure";
import { useAppearance, isThemePref } from "./hooks/useAppearance";
import { useConversations } from "./hooks/useConversations";
import type { Conversation, ServerStatus } from "./types";
import { ModelPicker } from "./components/ModelPicker";
import { ChatWindow } from "./components/ChatWindow";
import { MemoryPanel } from "./components/MemoryPanel";
import { EmptyState } from "./components/EmptyState";
import { Toast } from "./components/Toast";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ErrorBar } from "./components/ErrorBar";
import { LiveRegion } from "./components/LiveRegion";
import {
  WorkflowRunProvider,
  useWorkflowRunControl,
} from "./lib/workflow/run-context";
import {
  RoundtableRunProvider,
  useRoundtableRun,
} from "./lib/roundtable/run-context";
import { SettingsProvider } from "./contexts/SettingsContext";

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
const NAV_ITEMS: { id: ViewId; label: string; icon: React.ReactNode }[] = [
  // Flows leads the nav — orchestrating small local models is the headline.
  { id: "workflows", label: "Flows", icon: <Zap size={17} /> },
  { id: "chat", label: "Chat", icon: <MessageSquare size={17} /> },
  { id: "roundtable", label: "Table", icon: <Users size={17} /> },
  // Knowledge is a PILLAR (memory + RAG + history) — it was exiled to the
  // hamburger menu next to "Re-run setup wizard", making the pillar
  // undiscoverable in session one (product review 2026-06-10, IA #4).
  { id: "knowledge", label: "Knowledge", icon: <BookOpen size={17} /> },
  // The ViewId stays "mcp" (renaming the union/event-contract/topbar-slot id
  // would be invasive and risk breaking the froglips:navigate contract); only
  // the label, icon, and rendered component change. The hub renders
  // <SkillsToolsView/>, which embeds McpView for the registry browse flow.
  { id: "mcp", label: "Skills & Tools", icon: <Blocks size={17} /> },
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
            <span className="view-nav-icon" aria-hidden="true">
              {it.icon}
            </span>
            <span className="view-nav-label">{it.label}</span>
            {busy && <span className="view-nav-dot" />}
          </button>
        );
      })}
    </div>
  );
}
import { announce } from "./lib/announce";
import { parseTags } from "./lib/conversation-tags";
import "./App.css";

// Heavy panels that aren't needed for first paint: lazy-load so they ship in
// their own chunks. Each is gated behind a user action (sidebar button / fork
// gesture), so the small extra latency on first open is invisible against the
// network/disk fetch they trigger anyway.
const Dashboard = lazy(() =>
  import("./components/Dashboard").then((m) => ({ default: m.Dashboard })),
);
const DiagnosticsPanel = lazy(() =>
  import("./components/DiagnosticsPanel").then((m) => ({
    default: m.DiagnosticsPanel,
  })),
);
const PrivacyPanel = lazy(() =>
  import("./components/PrivacyPanel").then((m) => ({
    default: m.PrivacyPanel,
  })),
);
const ForkTreeModal = lazy(() =>
  import("./components/ForkTree").then((m) => ({ default: m.ForkTreeModal })),
);
const AboutYouModal = lazy(() =>
  import("./components/AboutYouModal").then((m) => ({
    default: m.AboutYouModal,
  })),
);
const AppearanceModal = lazy(() =>
  import("./components/AppearanceModal").then((m) => ({
    default: m.AppearanceModal,
  })),
);
const SettingsModal = lazy(() =>
  import("./components/SettingsModal").then((m) => ({
    default: m.SettingsModal,
  })),
);
// First-run-only flow: never seen by returning users, so it has no business
// living in the initial chunk. Mounts behind `wizardOpen === true`.
const SetupWizard = lazy(() =>
  import("./components/SetupWizard").then((m) => ({ default: m.SetupWizard })),
);
// Workflows canvas — React Flow + its CSS are heavy, so this stays in its own
// chunk that only fetches when the user opens the Workflows view.
const WorkflowsPage = lazy(() =>
  import("./components/workflows/WorkflowsPage").then((m) => ({
    default: m.WorkflowsPage,
  })),
);
// Knowledge surface — same lazy split as Workflows. The chunk only fetches
// when the user opens the Knowledge view, so first paint stays unaffected.
const KnowledgeView = lazy(() =>
  import("./components/KnowledgeView").then((m) => ({
    default: m.KnowledgeView,
  })),
);
// Skills & Tools hub — unified Skills | Toolsets surface. Lazy-split like the
// other main-pane views; its chunk only fetches when the user opens the hub.
// It statically imports McpView, so the registry browse flow rides along in
// this chunk rather than a separate McpView lazy import.
const SkillsToolsView = lazy(() =>
  import("./components/SkillsToolsView").then((m) => ({
    default: m.SkillsToolsView,
  })),
);
const RoundtableView = lazy(() =>
  import("./components/RoundtableView").then((m) => ({
    default: m.RoundtableView,
  })),
);

/**
 * Keyboard-shortcuts cheatsheet — a small, discoverable modal listing the
 * global shortcuts. Opened by pressing "?" outside any text field (and via the
 * command palette). Styled with the existing `.memories-*` modal classes so it
 * needs no new owned CSS file; the `<kbd>` chrome reuses the shared `.kbd`
 * style. The platform key glyph (⌘ vs Ctrl) is detected from the UA so the
 * displayed shortcuts match the active modifier the handler accepts.
 */
function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalA11y({ open: true, onClose, containerRef: ref });
  // The keydown handler accepts metaKey OR ctrlKey, so show the glyph that
  // matches the user's platform (⌘ on Apple, Ctrl elsewhere).
  const mod =
    typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform)
      ? "⌘"
      : "Ctrl";
  const rows: { keys: string[]; label: string }[] = [
    { keys: [mod, "N"], label: "New chat" },
    { keys: [mod, "K"], label: "Command palette" },
    { keys: [mod, "L"], label: "Browse & download models" },
    { keys: [mod, ","], label: "Open Settings" },
    { keys: ["?"], label: "Show this cheatsheet" },
    { keys: ["Esc"], label: "Close dialogs & menus" },
  ];
  return (
    <div
      className="memories-overlay"
      data-testid="shortcuts-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div ref={ref} className="memories-modal shortcuts-modal">
        <div className="memories-modal-header">
          <span>Keyboard shortcuts</span>
          <button onClick={onClose} aria-label="Close" className="memories-close">
            <X size={16} />
          </button>
        </div>
        <ul className="shortcuts-list">
          {rows.map((r) => (
            <li key={r.label} className="shortcuts-row">
              <span className="shortcuts-label">{r.label}</span>
              <span className="shortcuts-keys">
                {r.keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function App() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  // Self-healing send (2026-06-11): ModelPicker registers its "start the
  // current selection" handle here so ChatWindow can warm the model on
  // first send instead of gating the composer behind the Start button.
  const ensureStartRef = useRef<(() => Promise<boolean>) | null>(null);
  // The active conversation is shared across the conversation list, the model
  // picker, the chat window, and the fork tree, so it stays owned here and is
  // injected into `useConversations` rather than living inside it.
  const [current, setCurrent] = useState<Conversation | null>(null);
  const [memoryTick, setMemoryTick] = useState(0);
  const [panelWorkspace, setPanelWorkspace] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Conversation-list subsystem: list load/search/filter/forest, inline
  // rename + tag editing, pin toggle, and the soft-delete-with-undo machinery.
  const {
    conversations,
    conversationsRef,
    refreshConversations,
    editingId,
    editingTitle,
    setEditingTitle,
    tagEditingId,
    tagDraft,
    setTagDraft,
    convSearch,
    setConvSearch,
    pendingDelete,
    setPendingDelete,
    editInputRef,
    orderedConversations,
    deleteConv,
    commitDelete,
    undoDelete,
    togglePin,
    startTagEdit,
    commitTagEdit,
    cancelTagEdit,
    startEdit,
    commitEdit,
    cancelEdit,
  } = useConversations({ current, setCurrent, setErr });
  const { theme, themePref, toggleTheme, setThemePref, applyPersistedTheme } =
    useAppearance();
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  // Subsystem degradation pill (item 6): non-empty when any backend/mcp/
  // workspace subsystem is degraded or failed. Refreshed from the Rust health
  // registry on mount and whenever an `app-diagnostics` event fires (the same
  // events that record a degradation). Observational only — clicking opens the
  // existing Diagnostics panel.
  const [degradedHealth, setDegradedHealth] = useState<
    import("./lib/tauri-api").HealthSubsystem[]
  >([]);
  // DB recovery / availability banner (item 1). `dbNotice` holds the worst-case
  // startup DB condition surfaced from the Rust pool layer: an unavailable pool
  // (disk full / permission denied) or a corrupt DB that was quarantined +
  // recreated this run. Dismissible — once acknowledged it stays hidden for the
  // session. Polled once on mount; these conditions are fixed at startup.
  const [dbNotice, setDbNotice] = useState<{
    kind: "unavailable" | "recovered";
    detail: string;
  } | null>(null);
  const [dbNoticeDismissed, setDbNoticeDismissed] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Keyboard-shortcuts cheatsheet overlay — opened by pressing "?" outside any
  // text field (discoverability for the Cmd+N/L/K/, shortcuts).
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // RAM-pressure chip (inference wave D): macOS memorystatus level, polled
  // every 5s while visible. Renders ONLY at warn/critical — the early
  // warning before swap turns decode speed to sludge, invisible otherwise.
  const ramPressure = useRamPressure();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Silent background update check → a tasteful, dismissable toast.
  const availableUpdate = useUpdateCheck();
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [updateInstalling, setUpdateInstalling] = useState(false);
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
  const [convContextMenu, setConvContextMenu] = useState<{
    conv: Conversation;
    x: number;
    y: number;
  } | null>(null);
  // Viewport-clamped render position for the conversation context menu. The
  // raw click coords (convContextMenu.x/y) can put the menu off the right/
  // bottom edge; after it mounts we measure it and shift it back on-screen.
  const convMenuRef = useRef<HTMLDivElement>(null);
  const [convMenuPos, setConvMenuPos] = useState<{
    top: number;
    left: number;
  } | null>(null);
  useLayoutEffect(() => {
    if (!convContextMenu) return;
    const el = convMenuRef.current;
    if (!el) return;
    const M = 8; // keep an 8px gutter from each edge
    const r = el.getBoundingClientRect();
    const left = Math.max(
      M,
      Math.min(convContextMenu.x, window.innerWidth - r.width - M),
    );
    const top = Math.max(
      M,
      Math.min(convContextMenu.y, window.innerHeight - r.height - M),
    );
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
    // Seed the first-run-tour "seen" flag for an EXISTING user so the tour
    // never auto-opens for them — it's for genuinely-new installs only. The
    // FirstRunTour gates auto-open on the absence of this localStorage flag,
    // and a returning user's flag is brand new (so absent) without this seed.
    const seedTourSeen = () => {
      try {
        if (localStorage.getItem("froglips.tourSeen") === null) {
          localStorage.setItem("froglips.tourSeen", "true");
        }
      } catch {
        /* private mode / quota — tour reads the same key defensively */
      }
    };
    Promise.all([api.setupCompleteGet(), api.settingsGet()])
      .then(async ([done, s]) => {
        if (ignored) return;
        if (done) {
          // Returning user — never auto-show the tour.
          seedTourSeen();
          setWizardOpen(false);
          return;
        }
        if (s.last_model) {
          // Existing install pre-dating the wizard — also a returning user.
          seedTourSeen();
          await api.setupCompleteSet(true).catch(() => {});
          if (ignored) return;
          setWizardOpen(false);
          return;
        }
        // Genuinely-new user: leave the tour flag UNSET so it auto-opens once.
        setWizardOpen(true);
      })
      .catch((err) => {
        if (ignored) return;
        logDiag({
          level: "info",
          source: "app",
          message:
            "setupCompleteGet/settingsGet rejected — defaulting to showing the wizard",
          detail: err,
        });
        setWizardOpen(true);
      });
    // Configure the memory client + apply the persisted theme.
    api
      .settingsGet()
      .then((s) => {
        if (ignored) return;
        configureMemory({
          embeddingModel: s.embedding_model,
          recallThreshold: s.recall_threshold,
        });
        // `theme` is now a tri-state preference (light | dark | system); legacy
        // files only ever stored a concrete value, which still validates here.
        if (isThemePref(s.theme)) {
          applyPersistedTheme(s.theme);
        }
        // Apply all device-local appearance prefs (per-theme code palettes,
        // code/interface fonts, transcript size, high-contrast) now that the
        // app theme is set, plus the chat-bubble color.
        applyAllAppearance();
        applyBubbleColor();
      })
      .catch((err) => {
        if (ignored) return;
        logDiag({
          level: "warn",
          source: "app",
          message:
            "settingsGet() rejected on startup — memory client may use defaults",
          detail: err,
        });
      });
    return () => {
      ignored = true;
    };
  }, []);

  // Surface backend crash / restart / readiness-timeout messages the watcher
  // broadcasts on `server-status.last_error` (otherwise the model silently goes
  // to stopped and the user can't tell "restarting" from "dead"). Deduped via a
  // ref so a repeated payload doesn't re-spam the error bar.
  const lastBackendErrRef = useRef<string | null>(null);
  useTauriEvent<ServerStatus>(
    "server-status",
    useCallback((e) => {
      setStatus(e.payload);
      const le = e.payload.last_error ?? null;
      if (le && le !== lastBackendErrRef.current) {
        lastBackendErrRef.current = le;
        setErr(le);
      } else if (!le) {
        lastBackendErrRef.current = null;
      }
    }, []),
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
  useTauriEvent<{
    level: "info" | "warn" | "error";
    source: string;
    message: string;
    detail?: unknown;
  }>(
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
      // A degradation is always recorded alongside an app-diagnostics emit, so
      // re-poll the health registry here to keep the pill current. A recovery
      // clear() also rides one of these events.
      api
        .healthSnapshot()
        .then((rows) => setDegradedHealth(rows.filter((r) => r.state !== "ok")))
        .catch(() => {
          /* observational — leave the pill as-is on a transient IPC failure */
        });
    }, []),
  );

  // Initial health-registry poll on mount (degradations recorded during boot,
  // before the listener above attached, are surfaced on first render), plus a
  // modest 5s timer poll so the pill CLEARS once a subsystem recovers. A
  // recovery (state → ok) does not always ride an `app-diagnostics` event the
  // way a degradation does, so the event-driven re-poll above alone could leave
  // a stale "Degraded" pill up; this interval keeps it honest. Cleared on
  // unmount.
  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      api
        .healthSnapshot()
        .then((rows) => {
          if (!cancelled)
            setDegradedHealth(rows.filter((r) => r.state !== "ok"));
        })
        .catch(() => {
          /* observational — leave the pill as-is on a transient IPC failure */
        });
    };
    poll();
    const id = window.setInterval(poll, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // DB recovery / availability notice (item 1): probe the Rust pool layer once
  // on mount. An unavailable pool (disk full / permission denied at startup)
  // takes precedence over a corrupt-DB recovery, since with no pool the app is
  // largely non-functional and that's the more urgent message. Both conditions
  // are fixed at startup, so a single poll is sufficient.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const unavailable = await api.dbUnavailableNotice();
        if (cancelled) return;
        if (unavailable) {
          setDbNotice({ kind: "unavailable", detail: unavailable });
          return;
        }
        const recovered = await api.dbRecoveryNotice();
        if (cancelled) return;
        if (recovered) setDbNotice({ kind: "recovered", detail: recovered });
      } catch {
        /* observational — no banner on a transient IPC failure */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Recovery hook (review 2026-06): drain a leaked active-run counter from a
  // previous page lifetime (a renderer reload / crash that skipped agent_run_end
  // would otherwise pin ACTIVE_RUN_ROOT and reject every divergent
  // agent_set_workspace until restart). Main window only — calling it from the
  // quick/detached windows could drain a run still in flight here.
  useEffect(() => {
    void api.agentRunReset().catch(() => {
      /* best-effort; the guard degrades gracefully if absent */
    });
  }, []);

  // Track the agent workspace root so MemoryPanel can bind newly-created
  // project-scoped memories without re-asking the user. Refetched on every
  // memoryTick (covers workspace changes from inside ChatWindow) and on
  // conversation switch (cheap; just reads in-memory state on the Rust side).
  useEffect(() => {
    let cancelled = false;
    api
      .agentGetWorkspace()
      .then((p) => {
        if (!cancelled) setPanelWorkspace(p ?? null);
      })
      .catch((err) =>
        logDiag({
          level: "warn",
          source: "app",
          message:
            "agentGetWorkspace failed — MemoryPanel will fall back to global scope",
          detail: err,
        }),
      );
    return () => {
      cancelled = true;
    };
  }, [memoryTick, current?.id]);

  // Global keyboard shortcuts: Cmd+N new chat, Cmd+L library, Cmd+K model picker focus
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // "?" (no modifier) toggles the keyboard-shortcuts cheatsheet — but only
      // outside a text field so typing a literal "?" still works. Checked BEFORE
      // the modifier gate below since "?" carries no Cmd/Ctrl. Shift is implied
      // on most US layouts (Shift+/), so we don't require a specific modifier.
      const t = e.target as Element | null;
      const inField =
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        (t instanceof HTMLElement && t.isContentEditable);
      if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey && !inField) {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      // Don't hijack Cmd+N/L/K while the user is typing in a field — Cmd+N
      // inside the conv rename input or the workflow name input would
      // otherwise discard their edit by spawning a new chat. `select` is
      // intentionally NOT included (Cmd+K inside a model picker dropdown is
      // expected to do nothing — its focus shortcut is moot there anyway).
      // `isContentEditable` is the inherited property — a nested child of a
      // contenteditable root reports true, unlike `matches('[contenteditable]')`
      // which only catches the element with the attribute itself.
      if (inField) {
        return;
      }
      const key = e.key.toLowerCase();
      if (key === "n") {
        e.preventDefault();
        newChat();
        return;
      }
      if (key === "l") {
        e.preventDefault();
        // Click the Browse & download models option in picker
        const lib = document.querySelector<HTMLButtonElement>(
          "[data-shortcut='open-library']",
        );
        lib?.click();
        return;
      }
      if (key === "k") {
        // Cmd+K is the command palette now (product review 2026-06-10,
        // IA #7). The old behavior (focus the model picker) lives on as a
        // palette action, so the muscle memory path is Cmd+K → "model" →
        // Enter.
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (e.key === ",") {
        // Cmd+, — the platform-standard Settings shortcut (IA #2).
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // View navigation requests from components that don't own view state
  // (launchpad cards in EmptyChatLanding). Validated against ViewId so a
  // stray event can't put the app into a nonsense view.
  useEffect(() => {
    const VALID: ViewId[] = [
      "chat",
      "workflows",
      "knowledge",
      "mcp",
      "roundtable",
    ];
    const handler = (e: Event) => {
      const v = (e as CustomEvent<{ view?: string }>).detail?.view as
        | ViewId
        | undefined;
      if (v && VALID.includes(v)) setView(v);
    };
    window.addEventListener("froglips:navigate", handler);
    return () => window.removeEventListener("froglips:navigate", handler);
  }, []);

  // Open a specific conversation by id (Knowledge → History hits). Resolves
  // against the loaded list; unknown ids no-op rather than blanking the view.
  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent<{ id?: number }>).detail?.id;
      if (typeof id !== "number") return;
      const c = conversationsRef.current.find((x) => x.id === id);
      if (c) {
        setView("chat");
        setCurrent(c);
      }
    };
    window.addEventListener("froglips:open-conversation", handler);
    return () =>
      window.removeEventListener("froglips:open-conversation", handler);
  }, []);

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

  function newChat() {
    setCurrent(null);
    setView("chat");
  }

  // Command-palette action registry (Cmd+K). Flat list, fuzzy-filtered in
  // the palette; conversation jumping is wired separately via the
  // `conversations` prop. Function deps (newChat/toggleTheme) are component
  // function declarations — stable enough; the registry only needs to be
  // referentially fresh when the wizard/menu setters change, which is never.
  const paletteActions = useMemo<PaletteAction[]>(
    () => [
      {
        id: "view-flows",
        label: "Go to Flows",
        hint: "view",
        icon: paletteIcons.flows,
        run: () => setView("workflows"),
      },
      {
        id: "view-chat",
        label: "Go to Chat",
        hint: "view",
        icon: paletteIcons.chat,
        run: () => setView("chat"),
      },
      {
        id: "view-table",
        label: "Go to Table (Roundtable)",
        hint: "view",
        icon: paletteIcons.table,
        run: () => setView("roundtable"),
      },
      {
        id: "view-knowledge",
        label: "Go to Knowledge",
        hint: "view",
        icon: paletteIcons.knowledge,
        run: () => setView("knowledge"),
      },
      {
        id: "view-tools",
        label: "Go to Skills & Tools",
        hint: "view",
        icon: paletteIcons.tools,
        run: () => setView("mcp"),
      },
      {
        id: "new-chat",
        label: "New chat",
        hint: "⌘N",
        icon: paletteIcons.newChat,
        run: () => {
          setView("chat");
          newChat();
        },
      },
      {
        id: "toggle-theme",
        label: "Toggle light/dark theme",
        icon: paletteIcons.theme,
        run: () => toggleTheme(),
      },
      {
        id: "open-memories",
        label: "Open Memories",
        hint: "modal",
        run: () => setMemoriesOpen(true),
      },
      {
        id: "open-dashboard",
        label: "Open Dashboard",
        hint: "modal",
        run: () => setDashboardOpen(true),
      },
      {
        id: "open-diagnostics",
        label: "Open Diagnostics",
        hint: "modal",
        run: () => setDiagnosticsOpen(true),
      },
      {
        id: "open-privacy",
        label: "Open Privacy & Security",
        hint: "modal",
        run: () => setPrivacyOpen(true),
      },
      {
        id: "focus-model",
        label: "Focus model picker",
        run: () =>
          document
            .querySelector<HTMLElement>("[data-shortcut='focus-model']")
            ?.focus(),
      },
      {
        id: "open-library",
        label: "Browse & download models",
        hint: "⌘L",
        run: () =>
          document
            .querySelector<HTMLButtonElement>("[data-shortcut='open-library']")
            ?.click(),
      },
      {
        id: "open-settings",
        label: "Open Settings",
        hint: "⌘,",
        run: () => setSettingsOpen(true),
      },
      {
        id: "keyboard-shortcuts",
        label: "Keyboard shortcuts",
        hint: "?",
        run: () => setShortcutsOpen(true),
      },
      {
        id: "take-a-tour",
        label: "Take a tour",
        hint: "intro",
        icon: <Compass size={14} />,
        run: () => startFirstRunTour(),
      },
      {
        id: "rerun-wizard",
        label: "Re-run setup wizard",
        run: () => setWizardOpen(true),
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
    ],
    [],
  );

  const onPaletteOpenConversation = useCallback((c: Conversation) => {
    setView("chat");
    setCurrent(c);
  }, []);

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

  // Stable ChatWindow prop. Previously an inline arrow recreated on every App
  // render (RAM/health 5s polls + every status flip); ChatWindow folds it into
  // its `onSend` useCallback, so a fresh identity each render busted ChatInput's
  // React.memo and re-rendered the composer per tick. Reads `ensureStartRef`
  // (a ref) inside, so an empty dep list keeps it both stable AND current.
  const ensureModel = useCallback(
    () => ensureStartRef.current?.() ?? Promise.resolve(false),
    [],
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
        message:
          "onForked: listConversations after fork failed — sidebar still reflects the new conv",
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
      {/* DB recovery / availability banner (item 1). Dismissible startup notice
          surfaced when the SQLite pool failed to build (disk full / permission
          denied) or a corrupt DB was quarantined + recreated this run. Inline
          styles (no CSS file in this wave's ownership) using existing theme
          variables; spans the top of the window above the sidebar + main pane. */}
      {dbNotice && !dbNoticeDismissed && (
        <div
          className="db-startup-banner"
          role="alert"
          data-testid="db-startup-banner"
          data-kind={dbNotice.kind}
          style={{
            // Fixed overlay at the top so the banner never perturbs the locked
            // grid layout (sidebar | main). Dismissible.
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            padding: "8px 12px",
            background: "var(--warning-bg, rgba(217,168,108,0.14))",
            borderBottom: "1px solid var(--warning, #d9a86c)",
            backdropFilter: "blur(8px)",
            color: "var(--text, inherit)",
            fontSize: 13,
            zIndex: 1000,
          }}
        >
          <AlertTriangle
            size={15}
            aria-hidden="true"
            style={{ flexShrink: 0, marginTop: 1, color: "var(--warning, #d9a86c)" }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            {dbNotice.kind === "unavailable" ? (
              <>
                <strong>Database unavailable.</strong> Froglips couldn't open its
                local database, so history and memory are disabled this session.{" "}
                <span style={{ opacity: 0.85, wordBreak: "break-word" }}>
                  {dbNotice.detail}
                </span>
              </>
            ) : (
              <>
                <strong>Database recovered.</strong> A corrupt database was found
                on startup and moved aside; a fresh one was created. Your previous
                data is preserved at{" "}
                <span style={{ opacity: 0.85, wordBreak: "break-word" }}>
                  {dbNotice.detail}
                </span>
                .
              </>
            )}
          </div>
          <button
            type="button"
            data-testid="db-startup-banner-dismiss"
            aria-label="Dismiss database notice"
            onClick={() => setDbNoticeDismissed(true)}
            style={{
              flexShrink: 0,
              background: "transparent",
              border: "none",
              color: "inherit",
              cursor: "pointer",
              padding: 2,
              opacity: 0.7,
            }}
          >
            <X size={15} />
          </button>
        </div>
      )}
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
                if (menuCloseTimer.current != null)
                  clearTimeout(menuCloseTimer.current);
                menuCloseTimer.current = window.setTimeout(() => {
                  setMenuOpen(false);
                  menuCloseTimer.current = null;
                }, 150);
              }}
              title="Menu"
            >
              <Menu size={16} />
            </button>
            {menuOpen && (
              <div className="topbar-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  data-testid="open-dashboard"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setDashboardOpen(true);
                    setMenuOpen(false);
                  }}
                >
                  <BarChart3 size={16} aria-hidden="true" /> Dashboard
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="menu-memories"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setMemoriesOpen(true);
                    setMenuOpen(false);
                  }}
                >
                  <Star size={16} aria-hidden="true" /> Memories
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="menu-about-you"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setAboutYouOpen(true);
                    setMenuOpen(false);
                  }}
                >
                  <User size={16} aria-hidden="true" /> About You
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="menu-appearance"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setAppearanceOpen(true);
                    setMenuOpen(false);
                  }}
                >
                  <ImageIcon size={16} aria-hidden="true" /> Appearance
                </button>
                {current && (
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="menu-fork-tree"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setForkTreeOpen(true);
                      setMenuOpen(false);
                    }}
                  >
                    <GitBranch size={16} aria-hidden="true" /> Branches
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  data-testid="menu-settings"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setSettingsOpen(true);
                    setMenuOpen(false);
                  }}
                >
                  <Wrench size={16} aria-hidden="true" /> Settings…
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="menu-knowledge"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setView("knowledge");
                    setMenuOpen(false);
                  }}
                >
                  <BookOpen size={16} aria-hidden="true" /> Knowledge
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="menu-privacy"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setPrivacyOpen(true);
                    setMenuOpen(false);
                  }}
                >
                  <ShieldCheck size={16} aria-hidden="true" /> Privacy &amp;
                  safety
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="menu-diagnostics"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setDiagnosticsOpen(true);
                    setMenuOpen(false);
                  }}
                >
                  <Stethoscope size={16} aria-hidden="true" /> Diagnostics
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="menu-rerun-wizard"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={async () => {
                    setMenuOpen(false);
                    try {
                      await api.setupCompleteSet(false);
                    } catch (err) {
                      logDiag({
                        level: "warn",
                        source: "app",
                        message:
                          "setupCompleteSet(false) failed — wizard still opening locally",
                        detail: err,
                      });
                    }
                    setWizardOpen(true);
                  }}
                >
                  <Compass size={16} aria-hidden="true" /> Re-run setup wizard
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            className="topbar-btn topbar-collapse"
            aria-label={
              sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"
            }
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
        {/* Subsystem-degradation pill (item 6). Renders ONLY when a subsystem
            is degraded/failed; clicking opens the existing Diagnostics panel.
            Additive + observational — does not affect the locked top-row
            controls (hamburger / new-chat / search). */}
        {degradedHealth.length > 0 && (
          <button
            type="button"
            className="health-degraded-pill"
            data-testid="health-degraded-pill"
            title={degradedHealth
              .map((d) => `${d.name}: ${d.state} — ${d.reason}`)
              .join("\n")}
            aria-label={`${degradedHealth.length} subsystem${
              degradedHealth.length === 1 ? "" : "s"
            } degraded — open Diagnostics`}
            onClick={() => setDiagnosticsOpen(true)}
          >
            <AlertTriangle size={13} aria-hidden="true" /> Degraded
            {degradedHealth.length > 1 ? ` (${degradedHealth.length})` : ""}
          </button>
        )}
        {/* Stacked view-nav buttons (one per view). Knowledge stays in the
            hamburger menu (less-frequent editorial surface). */}
        <ViewNav view={view} setView={setView} />
        <button
          className="new-chat"
          onClick={newChat}
          data-testid="new-chat-btn"
          title="New chat (⌘N)"
        >
          + New chat <Kbd>⌘N</Kbd>
        </button>
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
                  icon={<MessageSquare size={24} />}
                  heading="No conversations yet"
                  sub="Start a new chat to begin — your threads will appear here."
                />
              ) : (
                <EmptyState
                  icon={<Search size={24} />}
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
                title={
                  depth > 0
                    ? "Branch — forked from another conversation"
                    : "Right-click for actions; double-click to rename"
                }
                style={
                  depth > 0
                    ? { paddingLeft: 8 + Math.min(depth, 4) * 14 }
                    : undefined
                }
              >
                {editingId === c.id ? (
                  <input
                    ref={editInputRef}
                    className="conv-rename"
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitEdit();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelEdit();
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                    autoFocus
                  />
                ) : (
                  <span className="conv-title">
                    <span className="conv-title-line">
                      {c.pinned && (
                        <span
                          className="conv-pin-dot"
                          aria-hidden="true"
                          title="Pinned"
                        >
                          <Pin size={11} />
                        </span>
                      )}
                      {depth > 0 && (
                        <span className="conv-branch-marker" aria-hidden="true">
                          ↳{" "}
                        </span>
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
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commitTagEdit();
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            cancelTagEdit();
                          }
                        }}
                        onClick={(e) => e.stopPropagation()}
                        autoFocus
                      />
                    ) : tags.length > 0 ? (
                      <span
                        className="conv-tags"
                        onClick={(e) => startTagEdit(c, e)}
                        title="Edit tags"
                      >
                        {tags.map((t) => (
                          <span key={t} className="conv-tag-chip">
                            {t}
                          </span>
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
                <Pin size={16} />{" "}
                {convContextMenu.conv.pinned ? "Unpin" : "Pin"}
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
                <Tag size={16} /> Edit tags…
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
                  api
                    .openConversationWindow(conv.id, conv.title)
                    .catch((err) => {
                      setErr(`Failed to open window: ${err}`);
                    });
                  setConvContextMenu(null);
                }}
              >
                <ExternalLink size={16} /> Open in new window
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
                <Trash2 size={16} /> Delete
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
              exposeStart={(fn) => {
                ensureStartRef.current = fn;
              }}
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
          {ramPressure >= 2 && (
            <span
              className={`ram-chip${ramPressure >= 4 ? " critical" : ""}`}
              title={
                ramPressure >= 4
                  ? "Memory pressure CRITICAL — macOS is swapping; unload a model or close apps before decode speed collapses."
                  : "Memory pressure elevated — consider unloading an idle model."
              }
              data-testid="ram-chip"
            >
              RAM {ramPressure >= 4 ? "critical" : "high"}
            </span>
          )}
          <button
            className="theme-toggle topbar-theme"
            onClick={toggleTheme}
            title={
              theme === "dark"
                ? "Switch to light theme"
                : "Switch to dark theme"
            }
            aria-label="Toggle theme"
          >
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
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
          <ErrorBoundary label="Skills & Tools">
            <Suspense fallback={null}>
              <SkillsToolsView />
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
              ensureModel={ensureModel}
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
          <Dashboard
            open={dashboardOpen}
            onClose={() => setDashboardOpen(false)}
          />
        </Suspense>
      )}
      {memoriesOpen && (
        <div
          className="memories-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setMemoriesOpen(false);
          }}
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
              <button
                onClick={() => setMemoriesOpen(false)}
                aria-label="Close"
                className="memories-close"
              >
                <X size={16} />
              </button>
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
            themePref={themePref}
            onSetThemePref={setThemePref}
          />
        </Suspense>
      )}
      {diagnosticsOpen && (
        <Suspense fallback={null}>
          <DiagnosticsPanel
            open={diagnosticsOpen}
            onClose={() => setDiagnosticsOpen(false)}
          />
        </Suspense>
      )}
      {privacyOpen && (
        <Suspense fallback={null}>
          <PrivacyPanel
            open={privacyOpen}
            onClose={() => setPrivacyOpen(false)}
          />
        </Suspense>
      )}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        actions={paletteActions}
        conversations={conversations}
        onOpenConversation={onPaletteOpenConversation}
      />
      {/* First-run guided tour (W5B). Self-gating: auto-opens once for a fresh
          user (localStorage `froglips.tourSeen`), never for returning users
          (App seeds the flag above), and re-openable via the palette / landing
          link. Always skippable — it never blocks the UI. */}
      <FirstRunTour />
      {shortcutsOpen && (
        <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />
      )}
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            status={status}
            themePref={themePref}
            onSetThemePref={setThemePref}
            onRerunWizard={() => setWizardOpen(true)}
          />
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
            onDone={async ({ samplePrompt, backend }) => {
              // Persist the wizard-complete flag so the next launch lands the
              // user straight in the chat. We do this even on the "Skip setup"
              // path — the user has explicitly opted out, so don't nag again.
              try {
                await api.setupCompleteSet(true);
              } catch (err) {
                logDiag({
                  level: "warn",
                  source: "app",
                  message:
                    "setupCompleteSet(true) failed — wizard will reopen on next launch",
                  detail: err,
                });
              }
              setWizardOpen(false);
              if (samplePrompt) {
                // Defer until the wizard has fully unmounted so ChatInput is
                // mounted and listening. The composer focuses + selects on
                // prefill internally.
                //
                // The sample prompts are agent-TOOL prompts ("what's in my
                // directory"). On a tool-capable backend, also arm agent mode
                // (ChatWindow flips it on once the just-auto-started server
                // reports ready, and opens the workspace picker if none is
                // set) so the first send actually reads real files instead of
                // hallucinating in plain chat.
                const agentCapable = backend === "ollama" || backend === "mlx";
                setTimeout(() => {
                  window.dispatchEvent(
                    new CustomEvent("chat-input:prefill", {
                      detail: { text: samplePrompt },
                    }),
                  );
                  if (agentCapable) {
                    window.dispatchEvent(
                      new CustomEvent("chat-window:agent-first-run"),
                    );
                  }
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
              if (p) {
                clearTimeout(p.timer);
                void commitDelete(p.conv.id);
              }
              return null;
            });
          }}
          durationMs={5000}
        />
      )}
      {availableUpdate && !updateDismissed && (
        <Toast
          message={
            updateInstalling
              ? `Updating to v${availableUpdate.version}…`
              : `Update available — v${availableUpdate.version}`
          }
          actionLabel={updateInstalling ? undefined : "Update & restart"}
          onAction={() => {
            setUpdateInstalling(true);
            void availableUpdate
              .install()
              .catch(() => setUpdateInstalling(false));
          }}
          onDismiss={() => setUpdateDismissed(true)}
          durationMs={3_600_000}
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
    <SettingsProvider>
      <WorkflowRunProvider>
        <RoundtableRunProvider>
          <App />
        </RoundtableRunProvider>
      </WorkflowRunProvider>
    </SettingsProvider>
  );
}

export default AppWithProviders;
// Named export kept for tests that import the inner component directly.
export { App };
