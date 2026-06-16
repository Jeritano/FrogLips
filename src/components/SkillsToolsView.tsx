import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Blocks,
  Eye,
  Pin,
  Trash2,
  X,
  Plug,
  Puzzle,
} from "lucide-react";
import { api } from "../lib/tauri-api";
import { announce } from "../lib/announce";
import { logDiag } from "../lib/diagnostics";
import {
  useSettingsField,
  useSettingsGetter,
  useUpdateSettings,
} from "../contexts/SettingsContext";
import {
  readCachedConfigs,
  reconcileConfigs,
  persistConfigs,
} from "../lib/mcp-servers";
import { TOOL_REGISTRY, type ToolCategory } from "../lib/agent-loop/tool-registry";
import { ConfirmDialog } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";
import { McpView } from "./McpView";
import type {
  ClaudeSkillRow,
  ClaudeSkillSummary,
  McpServerConfig,
  McpServerInfo,
} from "../types";
import "../styles/skills-tools.css";

/* ── Skills & Tools hub ───────────────────────────────────────────────────
 *
 * One unified main-pane surface (Hermes "Skills & Tools" model) over the three
 * capability sources Wave A wired into the data/gating layer:
 *   • Claude skills   — api.claudeSkill* + ClaudeSkillSummary.{enabled,pinned}
 *   • Built-in tools  — TOOL_REGISTRY, gated by settings.disabled_tools
 *   • MCP servers     — settings.mcp_servers[].enabled + live status
 *
 * This component is UI only. Gating is already enforced in the chat agent loop
 * once these settings are written. The per-preset allowlist + the per-tool
 * confirmation gate remain the hard security boundary; toggling a built-in
 * tool here only changes what is ADVERTISED to the model, never the gate.
 *
 * The MCP registry browse + add/install flow is NOT re-implemented: the
 * "Browse / add servers" affordance opens the existing <McpView/> in an overlay
 * so its registry-search + connect path is reused verbatim.
 */

type TopTab = "skills" | "toolsets";

const ALL = "__all__";

/** Stable empty array so the `disabled_tools` selector keeps a referentially
 *  stable default (required by useSettingsField's input-keyed cache). */
const EMPTY_STRINGS: string[] = [];

/* A built-in tool is ON unless its name is in settings.disabled_tools. */
function toolEnabled(disabled: string[], name: string): boolean {
  return !disabled.includes(name);
}

/* An MCP server is ON unless its config has enabled === false (undefined = on,
 * matching the chat-loop gating default). */
function mcpEnabled(cfg: McpServerConfig): boolean {
  return cfg.enabled !== false;
}

export function SkillsToolsView() {
  const [tab, setTab] = useState<TopTab>("skills");
  const [search, setSearch] = useState("");
  const [activeCat, setActiveCat] = useState<string>(ALL);
  const [err, setErr] = useState<string | null>(null);

  // Reset the category filter when switching tabs — the chip sets differ.
  const onSetTab = useCallback((t: TopTab) => {
    setTab(t);
    setActiveCat(ALL);
    setSearch("");
    setErr(null);
  }, []);

  // The hub renders its own in-pane tab/search bar rather than portaling into
  // the shared `#mcp-topbar-slot`. The slot is deliberately LEFT FREE so the
  // embedded <McpView/> (opened from "Browse / add servers") can portal ITS
  // Installed/Browse tabs there without colliding with the hub's bar.
  const tabBar = (
    <div className="st-tabs" role="tablist" aria-label="Skills & Tools">
      <button
        type="button"
        role="tab"
        aria-selected={tab === "skills"}
        className={`st-tab${tab === "skills" ? " sel" : ""}`}
        onClick={() => onSetTab("skills")}
        data-testid="st-tab-skills"
      >
        Skills
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === "toolsets"}
        className={`st-tab${tab === "toolsets" ? " sel" : ""}`}
        onClick={() => onSetTab("toolsets")}
        data-testid="st-tab-toolsets"
      >
        Toolsets
      </button>
      <div className="st-tabspacer" />
      <input
        type="search"
        className="st-search"
        placeholder={tab === "skills" ? "Search skills…" : "Search tools…"}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label={tab === "skills" ? "Search skills" : "Search tools"}
        data-testid="st-search"
      />
    </div>
  );

  return (
    <div className="st-root" data-testid="skills-tools-view">
      {tabBar}

      {err && (
        <div className="st-err" role="alert">
          {err}
          <button
            type="button"
            className="st-err-x"
            onClick={() => setErr(null)}
            aria-label="Dismiss error"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {tab === "skills" ? (
        <SkillsTab
          search={search}
          activeCat={activeCat}
          setActiveCat={setActiveCat}
          onError={setErr}
        />
      ) : (
        <ToolsetsTab
          search={search}
          activeCat={activeCat}
          setActiveCat={setActiveCat}
          onError={setErr}
        />
      )}
    </div>
  );
}

/* ── Shared bits ────────────────────────────────────────────────────────── */

function Switch({
  on,
  onToggle,
  label,
  disabled,
  testid,
}: {
  on: boolean;
  onToggle: () => void;
  label: string;
  disabled?: boolean;
  testid?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className="st-switch"
      disabled={disabled}
      onClick={onToggle}
      data-testid={testid}
    />
  );
}

function CategoryChips({
  counts,
  active,
  onPick,
  total,
}: {
  counts: { cat: string; n: number }[];
  active: string;
  onPick: (cat: string) => void;
  total: number;
}) {
  return (
    <div className="st-chips" role="tablist" aria-label="Categories">
      <button
        type="button"
        role="tab"
        aria-selected={active === ALL}
        className={`st-chip${active === ALL ? " sel" : ""}`}
        onClick={() => onPick(ALL)}
      >
        All <span className="st-chip-count">{total}</span>
      </button>
      {counts.map(({ cat, n }) => (
        <button
          key={cat}
          type="button"
          role="tab"
          aria-selected={active === cat}
          className={`st-chip${active === cat ? " sel" : ""}`}
          onClick={() => onPick(cat)}
        >
          {cat} <span className="st-chip-count">{n}</span>
        </button>
      ))}
    </div>
  );
}

function matches(search: string, ...fields: string[]): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => f.toLowerCase().includes(q));
}

/* ── Skills tab ─────────────────────────────────────────────────────────── */

function SkillsTab({
  search,
  activeCat,
  setActiveCat,
  onError,
}: {
  search: string;
  activeCat: string;
  setActiveCat: (c: string) => void;
  onError: (e: string | null) => void;
}) {
  const supported = "claudeSkillList" in api;
  const [list, setList] = useState<ClaudeSkillSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [viewing, setViewing] = useState<ClaudeSkillRow | null>(null);
  const [pendingDelete, setPendingDelete] =
    useState<ClaudeSkillSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Per-skill optimistic toggle: name → pending bool. Reverts on failure.
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async () => {
    if (!supported) return;
    setLoading(true);
    try {
      const rows = await api.claudeSkillList(false);
      setList(rows);
      setOptimistic({});
    } catch (e) {
      onError(`Load failed: ${e}`);
      logDiag({
        level: "warn",
        source: "skills-tools",
        message: "claudeSkillList failed",
        detail: e,
      });
    } finally {
      setLoading(false);
    }
  }, [supported, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const isEnabled = useCallback(
    (s: ClaudeSkillSummary) =>
      s.name in optimistic ? optimistic[s.name] : s.enabled,
    [optimistic],
  );

  const onToggle = useCallback(
    async (s: ClaudeSkillSummary) => {
      const next = !isEnabled(s);
      setOptimistic((m) => ({ ...m, [s.name]: next }));
      try {
        await api.claudeSkillSetEnabled(s.name, next);
        announce(next ? `Enabled skill ${s.name}` : `Disabled skill ${s.name}`);
      } catch (e) {
        // Revert the optimistic flag for just this skill.
        setOptimistic((m) => {
          const rest: Record<string, boolean> = {};
          for (const k of Object.keys(m)) if (k !== s.name) rest[k] = m[k];
          return rest;
        });
        onError(`Toggle failed: ${e}`);
      }
    },
    [isEnabled, onError],
  );

  const onTogglePinned = useCallback(
    async (s: ClaudeSkillSummary) => {
      try {
        await api.claudeSkillSetPinned(s.name, !s.pinned);
        announce(
          !s.pinned ? `Pinned skill ${s.name}` : `Unpinned skill ${s.name}`,
        );
        await refresh();
      } catch (e) {
        onError(`Pin failed: ${e}`);
      }
    },
    [refresh, onError],
  );

  const onView = useCallback(
    async (s: ClaudeSkillSummary) => {
      try {
        const full = await api.claudeSkillGet(s.name);
        if (!full) {
          onError(`Skill "${s.name}" no longer exists.`);
          return;
        }
        setViewing(full);
      } catch (e) {
        onError(`Inspect failed: ${e}`);
      }
    },
    [onError],
  );

  const onConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.claudeSkillDelete(pendingDelete.name);
      announce(`Deleted skill ${pendingDelete.name}`);
      setPendingDelete(null);
      await refresh();
    } catch (e) {
      onError(`Delete failed: ${e}`);
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, refresh, onError]);

  // Import — reuse the directory picker + claude_skill_import flow.
  const onImport = useCallback(async () => {
    if (!supported || importing) return;
    let folder: string | null = null;
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const res = await openDialog({
        directory: true,
        multiple: false,
        title: "Import Claude Skill folder",
      });
      folder = Array.isArray(res) ? (res[0] ?? null) : res;
    } catch (e) {
      onError(
        `Folder picker failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    if (!folder) return;
    setImporting(true);
    onError(null);
    try {
      const row = await api.claudeSkillImport(folder, false);
      announce(`Imported skill ${row.name}`);
      await refresh();
    } catch (e) {
      // Surface the collision/other error as text; the dense hub keeps the
      // overwrite-confirm flow in the dedicated ClaudeSkillsPanel.
      const msg =
        e && typeof e === "object" && "message" in (e as Record<string, unknown>)
          ? String((e as { message: unknown }).message)
          : String(e);
      onError(
        msg.includes("name_collision")
          ? `A skill with that name already exists. Open it to re-import/overwrite.`
          : `Import failed: ${msg}`,
      );
    } finally {
      setImporting(false);
    }
  }, [supported, importing, refresh, onError]);

  // Category counts over the FULL list (chips show totals, not the filtered
  // subset — matching the Hermes "All 24 / Apple 5 …" pattern).
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of list) m.set(s.category, (m.get(s.category) ?? 0) + 1);
    return [...m.entries()]
      .map(([cat, n]) => ({ cat, n }))
      .sort((a, b) => a.cat.localeCompare(b.cat));
  }, [list]);

  // Filter by chip + search, then group by category, pinned-first within group.
  const grouped = useMemo(() => {
    const filtered = list.filter(
      (s) =>
        (activeCat === ALL || s.category === activeCat) &&
        matches(search, s.name, s.description, s.category),
    );
    const byCat = new Map<string, ClaudeSkillSummary[]>();
    for (const s of filtered) {
      const arr = byCat.get(s.category) ?? [];
      arr.push(s);
      byCat.set(s.category, arr);
    }
    return [...byCat.entries()]
      .map(([cat, rows]) => ({
        cat,
        rows: rows.sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          return a.name.localeCompare(b.name);
        }),
      }))
      .sort((a, b) => a.cat.localeCompare(b.cat));
  }, [list, activeCat, search]);

  if (!supported) {
    return (
      <div className="st-body">
        <EmptyState
          icon={<Puzzle size={24} />}
          heading="Skills not yet available"
          sub="(claude skills feature not yet available)"
        />
      </div>
    );
  }

  return (
    <>
      <div className="st-toolbar">
        <button
          type="button"
          className="st-browse-btn"
          onClick={() => void onImport()}
          disabled={importing}
          data-testid="st-skills-import"
        >
          <Puzzle size={15} aria-hidden="true" />
          {importing ? "Importing…" : "Import skill"}
        </button>
      </div>

      <CategoryChips
        counts={counts}
        active={activeCat}
        onPick={setActiveCat}
        total={list.length}
      />

      <div className="st-body" data-testid="st-skills-body">
        {list.length === 0 && !loading ? (
          <EmptyState
            icon={<Puzzle size={24} />}
            heading="No skills imported"
            sub="Import a folder containing a SKILL.md file. Enabled skills are offered to the chat agent."
          />
        ) : grouped.length === 0 ? (
          <div className="st-empty">No skills match your search.</div>
        ) : (
          grouped.map(({ cat, rows }) => (
            <section className="st-section" key={cat}>
              <div className="st-section-head">{cat}</div>
              {rows.map((s) => {
                const on = isEnabled(s);
                return (
                  <div
                    className="st-row"
                    key={s.id}
                    data-testid={`st-skill-row-${s.name}`}
                  >
                    <div className="st-row-main">
                      <div className="st-row-title">
                        <span className="st-row-name">{s.name}</span>
                        {s.pinned && (
                          <span className="st-badge st-badge-pinned">
                            <Pin size={9} aria-hidden="true" /> pinned
                          </span>
                        )}
                      </div>
                      <div className="st-row-desc">{s.description}</div>
                    </div>
                    <div className="st-row-actions">
                      <button
                        type="button"
                        className="st-iconbtn"
                        onClick={() => void onView(s)}
                        aria-label={`View ${s.name}`}
                        title="View body"
                        data-testid={`st-skill-view-${s.name}`}
                      >
                        <Eye size={15} />
                      </button>
                      <button
                        type="button"
                        className={`st-iconbtn${s.pinned ? " is-on" : ""}`}
                        onClick={() => void onTogglePinned(s)}
                        aria-label={s.pinned ? `Unpin ${s.name}` : `Pin ${s.name}`}
                        aria-pressed={s.pinned}
                        title={s.pinned ? "Unpin" : "Pin"}
                      >
                        <Pin size={15} />
                      </button>
                      <button
                        type="button"
                        className="st-iconbtn danger"
                        onClick={() => setPendingDelete(s)}
                        aria-label={`Delete ${s.name}`}
                        title="Delete"
                        data-testid={`st-skill-delete-${s.name}`}
                      >
                        <Trash2 size={15} />
                      </button>
                      <Switch
                        on={on}
                        onToggle={() => void onToggle(s)}
                        label={`${on ? "Disable" : "Enable"} skill ${s.name}`}
                        testid={`st-skill-toggle-${s.name}`}
                      />
                    </div>
                  </div>
                );
              })}
            </section>
          ))
        )}
      </div>

      {viewing && (
        <SkillBodyViewer skill={viewing} onClose={() => setViewing(null)} />
      )}

      {pendingDelete && (
        <ConfirmDialog
          ariaLabel={`Delete skill ${pendingDelete.name}`}
          data-testid="st-skill-delete-confirm"
          boxClassName="risk-destructive"
          title={
            <>
              Delete skill <code>{pendingDelete.name}</code>?
            </>
          }
          onDismiss={() => {
            if (!deleting) setPendingDelete(null);
          }}
          actions={
            <>
              <button
                type="button"
                className="agent-confirm-deny"
                onClick={() => setPendingDelete(null)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="agent-confirm-allow"
                data-testid="st-skill-delete-confirm-allow"
                onClick={() => void onConfirmDelete()}
                disabled={deleting}
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </>
          }
        >
          <div className="cs-confirm-body">
            The skill will be removed from the global library. Chat agents will
            no longer see it. This cannot be undone.
          </div>
        </ConfirmDialog>
      )}
    </>
  );
}

/** Minimal read-only body viewer for a skill (name + source + body_md). */
function SkillBodyViewer({
  skill,
  onClose,
}: {
  skill: ClaudeSkillRow;
  onClose: () => void;
}) {
  return (
    <div
      className="cs-body-overlay"
      data-testid="st-skill-body-viewer"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="cs-body-box"
        role="dialog"
        aria-modal="true"
        aria-label={`Body for ${skill.name}`}
      >
        <header className="cs-body-header">
          <h3 className="cs-body-title">
            Skill · <code>{skill.name}</code>
          </h3>
          <button
            type="button"
            className="cs-panel-close"
            onClick={onClose}
            aria-label="Close body viewer"
          >
            <X size={16} />
          </button>
        </header>
        <div className="cs-body-meta">
          <div className="cs-body-meta-row">
            <span className="cs-body-meta-label">Source:</span>
            <code className="cs-body-meta-path" title={skill.source_path}>
              {skill.source_path}
            </code>
          </div>
        </div>
        <pre className="cs-body-pre">{skill.body_md}</pre>
      </div>
    </div>
  );
}

/* ── Toolsets tab ───────────────────────────────────────────────────────── */

const MCP_CAT = "MCP";

function ToolsetsTab({
  search,
  activeCat,
  setActiveCat,
  onError,
}: {
  search: string;
  activeCat: string;
  setActiveCat: (c: string) => void;
  onError: (e: string | null) => void;
}) {
  const disabledTools = useSettingsField(
    (s) => s?.disabled_tools ?? EMPTY_STRINGS,
  );
  const updateSettings = useUpdateSettings();
  const getSettings = useSettingsGetter();
  const [browseOpen, setBrowseOpen] = useState(false);

  // ── Built-in tools (chat scope only — workflow/subagent-special tools are
  // not user-facing capabilities of the chat agent). ──────────────────────
  const builtins = useMemo(
    () => TOOL_REGISTRY.filter((d) => d.scope === "chat"),
    [],
  );

  const setToolEnabled = useCallback(
    async (name: string, enabled: boolean) => {
      const current = (await getSettings()).disabled_tools ?? [];
      const set = new Set(current);
      if (enabled) set.delete(name);
      else set.add(name);
      try {
        await updateSettings({ disabled_tools: [...set] });
        announce(enabled ? `Enabled tool ${name}` : `Disabled tool ${name}`);
      } catch (e) {
        onError(`Toggle failed: ${e}`);
      }
    },
    [getSettings, updateSettings, onError],
  );

  // Per-category bulk toggle: turn the whole category ON or OFF.
  const setCategoryEnabled = useCallback(
    async (names: string[], enabled: boolean) => {
      const current = (await getSettings()).disabled_tools ?? [];
      const set = new Set(current);
      for (const n of names) {
        if (enabled) set.delete(n);
        else set.add(n);
      }
      try {
        await updateSettings({ disabled_tools: [...set] });
      } catch (e) {
        onError(`Toggle failed: ${e}`);
      }
    },
    [getSettings, updateSettings, onError],
  );

  // ── MCP servers (config + live status). ─────────────────────────────────
  const [configs, setConfigs] = useState<McpServerConfig[]>(() =>
    readCachedConfigs(),
  );
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getSettings()
      .then((s) => {
        if (cancelled) return;
        const { configs: reconciled, migrated } = reconcileConfigs(s);
        setConfigs(reconciled);
        if (migrated) void persistConfigs(reconciled, updateSettings);
      })
      .catch(() => {
        /* keep cached list */
      });
    return () => {
      cancelled = true;
    };
  }, [getSettings, updateSettings]);

  const refreshing = useRef(false);
  const refreshServers = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const raw = await api.mcpListServers();
      setServers(Array.isArray(raw) ? raw : []);
    } catch {
      /* transient — keep prior status */
    } finally {
      refreshing.current = false;
    }
  }, []);

  useEffect(() => {
    void refreshServers();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void refreshServers();
    }, 4000);
    const onVis = () => {
      if (document.visibilityState === "visible") void refreshServers();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refreshServers]);

  // Re-read configs when the browse overlay closes (the user may have added a
  // server there) and after any local change.
  useEffect(() => {
    if (browseOpen) return;
    void getSettings()
      .then((s) => setConfigs(reconcileConfigs(s).configs))
      .catch(() => undefined);
    void refreshServers();
  }, [browseOpen, getSettings, refreshServers]);

  const statusByName = useMemo(() => {
    const m: Record<string, McpServerInfo> = {};
    for (const s of servers) m[s.name] = s;
    return m;
  }, [servers]);

  const persistConfigList = useCallback(
    (next: McpServerConfig[]) => {
      setConfigs(next);
      void persistConfigs(next, updateSettings);
    },
    [updateSettings],
  );

  const toggleMcpEnabled = useCallback(
    (cfg: McpServerConfig) => {
      const next = configs.map((c) =>
        c.name === cfg.name ? { ...c, enabled: !mcpEnabled(c) } : c,
      );
      persistConfigList(next);
      announce(
        mcpEnabled(cfg)
          ? `Disabled MCP server ${cfg.name}`
          : `Enabled MCP server ${cfg.name}`,
      );
    },
    [configs, persistConfigList],
  );

  const startServer = useCallback(
    async (cfg: McpServerConfig) => {
      setBusy(cfg.name);
      onError(null);
      try {
        if (cfg.url) await api.mcpStartRemoteServer(cfg.name, cfg.url);
        else await api.mcpStartServer(cfg.name, cfg.command, cfg.args, cfg.env);
        await refreshServers();
      } catch (e) {
        onError(
          `Start '${cfg.name}': ${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        setBusy(null);
      }
    },
    [refreshServers, onError],
  );

  const stopServer = useCallback(
    async (name: string) => {
      setBusy(name);
      try {
        await api.mcpStopServer(name);
        await refreshServers();
      } catch (e) {
        onError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [refreshServers, onError],
  );

  // ── Category chips: built-in tool categories present + "MCP". ────────────
  const builtinCats = useMemo(() => {
    const m = new Map<ToolCategory, number>();
    for (const d of builtins) m.set(d.category, (m.get(d.category) ?? 0) + 1);
    return m;
  }, [builtins]);

  const counts = useMemo(() => {
    const arr = [...builtinCats.entries()]
      .map(([cat, n]) => ({ cat: cat as string, n }))
      .sort((a, b) => a.cat.localeCompare(b.cat));
    arr.push({ cat: MCP_CAT, n: configs.length });
    return arr;
  }, [builtinCats, configs.length]);

  const total = builtins.length + configs.length;

  // ── Built-in tool sections (filtered). ──────────────────────────────────
  const toolSections = useMemo(() => {
    if (activeCat === MCP_CAT) return [];
    const filtered = builtins.filter(
      (d) =>
        (activeCat === ALL || d.category === activeCat) &&
        matches(search, d.name, d.schema.description, d.category),
    );
    const byCat = new Map<ToolCategory, typeof builtins>();
    for (const d of filtered) {
      const arr = byCat.get(d.category) ?? [];
      arr.push(d);
      byCat.set(d.category, arr);
    }
    return [...byCat.entries()]
      .map(([cat, tools]) => ({
        cat: cat as string,
        tools: tools.sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.cat.localeCompare(b.cat));
  }, [builtins, activeCat, search]);

  // ── MCP rows (filtered). ─────────────────────────────────────────────────
  const showMcp = activeCat === ALL || activeCat === MCP_CAT;
  const mcpRows = useMemo(
    () =>
      configs.filter((c) =>
        matches(search, c.name, c.url ?? "", c.command ?? ""),
      ),
    [configs, search],
  );

  const nothing =
    toolSections.length === 0 && (!showMcp || mcpRows.length === 0);

  return (
    <>
      <CategoryChips
        counts={counts}
        active={activeCat}
        onPick={setActiveCat}
        total={total}
      />

      <div className="st-body" data-testid="st-toolsets-body">
        <div className="st-note">
          Turning a built-in tool off here only removes it from what the agent
          is offered. The per-preset allowlist and per-tool confirmation prompts
          remain the security gate — a dangerous tool still requires your
          approval each time it runs.
        </div>

        {toolSections.map(({ cat, tools }) => {
          const names = tools.map((t) => t.name);
          const allOn = names.every((n) => toolEnabled(disabledTools, n));
          return (
            <section className="st-section" key={cat}>
              <div className="st-section-head">
                {cat}
                <button
                  type="button"
                  className="st-section-toggle-all"
                  onClick={() => void setCategoryEnabled(names, !allOn)}
                  data-testid={`st-tool-cat-toggle-${cat}`}
                >
                  {allOn ? "Disable all" : "Enable all"}
                </button>
              </div>
              {tools.map((d) => {
                const on = toolEnabled(disabledTools, d.name);
                return (
                  <div
                    className="st-row"
                    key={d.name}
                    data-testid={`st-tool-row-${d.name}`}
                  >
                    <div className="st-row-main">
                      <div className="st-row-title">
                        <span className="st-row-name">{d.name}</span>
                        {d.dangerous && (
                          <span className="st-badge st-badge-status danger">
                            needs approval
                          </span>
                        )}
                      </div>
                      <div className="st-row-desc">{d.schema.description}</div>
                    </div>
                    <div className="st-row-actions">
                      <Switch
                        on={on}
                        onToggle={() => void setToolEnabled(d.name, !on)}
                        label={`${on ? "Disable" : "Enable"} tool ${d.name}`}
                        testid={`st-tool-toggle-${d.name}`}
                      />
                    </div>
                  </div>
                );
              })}
            </section>
          );
        })}

        {showMcp && (
          <section className="st-section">
            <div className="st-section-head">{MCP_CAT}</div>
            {mcpRows.length === 0 ? (
              <div className="st-empty">
                <Plug size={18} aria-hidden="true" />
                {configs.length === 0
                  ? "No MCP servers configured yet."
                  : "No MCP servers match your search."}
              </div>
            ) : (
              mcpRows.map((cfg) => {
                const info = statusByName[cfg.name];
                const status = info?.status ?? "stopped";
                const running = status === "running";
                const on = mcpEnabled(cfg);
                return (
                  <div
                    className="st-row"
                    key={cfg.name}
                    data-testid={`st-mcp-row-${cfg.name}`}
                  >
                    <div className="st-row-main">
                      <div className="st-row-title">
                        <span className="st-row-name">{cfg.name}</span>
                        <span
                          className={`st-badge st-badge-status${
                            running ? " running" : ""
                          }`}
                        >
                          {status}
                        </span>
                        {running && info && (
                          <span className="st-badge st-badge-status">
                            {info.tool_count} tools
                          </span>
                        )}
                      </div>
                      <div className="st-row-desc">
                        {cfg.url ??
                          `${cfg.command} ${(cfg.args ?? []).join(" ")}`.trim()}
                        {info?.last_error ? ` — ${info.last_error}` : ""}
                      </div>
                    </div>
                    <div className="st-row-actions">
                      {running ? (
                        <button
                          type="button"
                          className="st-browse-btn"
                          onClick={() => void stopServer(cfg.name)}
                          disabled={busy === cfg.name}
                        >
                          Stop
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="st-browse-btn"
                          onClick={() => void startServer(cfg)}
                          disabled={busy === cfg.name}
                        >
                          {busy === cfg.name ? "Starting…" : "Start"}
                        </button>
                      )}
                      <Switch
                        on={on}
                        onToggle={() => toggleMcpEnabled(cfg)}
                        label={`${on ? "Disable" : "Enable"} MCP server ${cfg.name}`}
                        testid={`st-mcp-toggle-${cfg.name}`}
                      />
                    </div>
                  </div>
                );
              })
            )}
            <div className="st-browse-row">
              <button
                type="button"
                className="st-browse-btn"
                onClick={() => setBrowseOpen(true)}
                data-testid="st-mcp-browse"
              >
                <Plug size={15} aria-hidden="true" /> Browse / add servers
              </button>
            </div>
          </section>
        )}

        {nothing && !showMcp && (
          <div className="st-empty">No tools match your search.</div>
        )}
      </div>

      {browseOpen && (
        <McpBrowseOverlay onClose={() => setBrowseOpen(false)} />
      )}
    </>
  );
}

/**
 * Overlay that embeds the existing <McpView/> so the registry browse + add /
 * connect / OAuth flow is reused verbatim (never re-implemented). McpView
 * portals its own tab bar into `#mcp-topbar-slot`, which exists while this hub
 * is the active view, so its Installed/Browse tabs render in the header row.
 */
function McpBrowseOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="cs-body-overlay"
      data-testid="st-mcp-browse-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Browse and add MCP servers"
    >
      <div
        className="cs-body-box"
        style={{ width: "min(900px, 92vw)", height: "min(640px, 86vh)" }}
      >
        <header className="cs-body-header">
          <h3 className="cs-body-title">
            <Blocks size={15} aria-hidden="true" /> MCP servers
          </h3>
          <button
            type="button"
            className="cs-panel-close"
            onClick={onClose}
            aria-label="Close server browser"
          >
            <X size={16} />
          </button>
        </header>
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
          <McpView />
        </div>
      </div>
    </div>
  );
}
