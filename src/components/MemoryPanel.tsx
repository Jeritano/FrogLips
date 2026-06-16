import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Download, Star, X } from "lucide-react";
import { api } from "../lib/tauri-api";
import { logDiag } from "../lib/diagnostics";
import { useTwoClickConfirm } from "../lib/use-two-click-confirm";
import type { Memory, MemoryMode, MemoryScope } from "../types";
import {
  demoteMemory,
  getMemoryMode,
  promoteMemory,
  saveMemory,
  setMemoryMode,
} from "../lib/memory-client";
import { EmptyState } from "./EmptyState";
import { ErrorBar } from "./ErrorBar";

interface Props {
  refreshToken?: number;
  /** Current workspace root, used to bind newly-created project memories. */
  workspaceRoot?: string | null;
  /** Current conversation id, used to bind newly-created conversation memories. */
  conversationId?: number | null;
}

type ScopeFilter = "all" | MemoryScope;

/* ── Scope badge metadata ───────────────────────────────────────────────── */

const SCOPE_LABELS: Record<MemoryScope, string> = {
  global: "Global",
  project: "Project",
  conversation: "Conversation",
};

const SCOPE_LETTERS: Record<MemoryScope, string> = {
  global: "G",
  project: "P",
  conversation: "C",
};

/* ── Memory mode metadata ───────────────────────────────────────────────
 * Plain-language display labels + one-line descriptions. The stored enum
 * VALUES (off/manual/queue/direct) are unchanged — only what the user sees. */

const MODE_OPTIONS: { value: MemoryMode; label: string; desc: string }[] = [
  { value: "off", label: "Off", desc: "Memory disabled." },
  {
    value: "manual",
    label: "Suggest",
    desc: "Recalls memories; add them yourself.",
  },
  {
    value: "queue",
    label: "Review",
    desc: "Auto-extracts into a queue you approve.",
  },
  { value: "direct", label: "Auto", desc: "Auto-extracts and auto-approves." },
];

/** Promote chain: conversation → project → global. */
function nextUp(s: MemoryScope): MemoryScope | null {
  if (s === "conversation") return "project";
  if (s === "project") return "global";
  return null;
}

/** Demote chain: global → project → conversation. */
function nextDown(s: MemoryScope): MemoryScope | null {
  if (s === "global") return "project";
  if (s === "project") return "conversation";
  return null;
}

export function MemoryPanel({
  refreshToken,
  workspaceRoot,
  conversationId,
}: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<Memory[]>([]);
  const [pending, setPending] = useState<Memory[]>([]);
  const [mode, setMode] = useState<MemoryMode>(getMemoryMode());
  const [tab, setTab] = useState<"active" | "pending">("active");
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [newMemoryText, setNewMemoryText] = useState("");
  const [newMemoryScope, setNewMemoryScope] = useState<MemoryScope>("global");
  const [savingNew, setSavingNew] = useState(false);
  // Tauri 2 webview disables window.confirm — use an inline two-click pattern
  // for memory deletion so the destructive flow can't short-circuit silently.
  const deleteConfirm = useTwoClickConfirm();

  // Monotonic request id so a slower earlier refresh can't paint over a
  // newer one's results (out-of-order resolution on rapid scope changes).
  // LOW (2026-05-29).
  const refreshSeqRef = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    try {
      // Pass workspaceRoot + conversationId so the Rust layer applies the
      // same scope filter the search paths use. Without this the panel
      // leaked conversation-scoped memories from other chats and
      // project-scoped memories from other workspaces.
      const [a, p] = await Promise.all([
        api.listMemories(
          "active",
          workspaceRoot ?? null,
          conversationId ?? null,
        ),
        api.listMemories(
          "pending",
          workspaceRoot ?? null,
          conversationId ?? null,
        ),
      ]);
      if (seq !== refreshSeqRef.current) return; // superseded by a newer refresh
      setActive(a);
      setPending(p);
    } catch (err) {
      logDiag({
        level: "warn",
        source: "memory-panel",
        message: "refresh: listMemories failed — panel will show stale data",
        detail: err,
      });
    }
  }, [workspaceRoot, conversationId]);

  // Refresh on open AND on every refreshToken bump — even while collapsed —
  // so the count badge (active.length / pending.length) stays accurate after
  // onMemoriesChanged fires without the panel needing to be opened first.
  useEffect(() => {
    refresh();
  }, [open, refreshToken, refresh]);

  function changeMode(m: MemoryMode) {
    setMode(m);
    setMemoryMode(m);
  }

  async function approve(id: number) {
    setBusy(id);
    setErr(null);
    try {
      await api.updateMemoryStatus(id, "active");
      await refresh();
    } catch (e) {
      setErr(`Approve failed: ${e}`);
    } finally {
      setBusy(null);
    }
  }

  async function reject(id: number) {
    setBusy(id);
    setErr(null);
    try {
      await api.deleteMemory(id);
      await refresh();
    } catch (e) {
      setErr(`Reject failed: ${e}`);
    } finally {
      setBusy(null);
    }
  }

  async function del(id: number) {
    setBusy(id);
    setErr(null);
    try {
      await api.deleteMemory(id);
      await refresh();
    } catch (e) {
      setErr(`Delete failed: ${e}`);
    } finally {
      setBusy(null);
    }
  }

  async function promote(m: Memory) {
    setBusy(m.id);
    setErr(null);
    try {
      // Promoting conversation → project requires a project_root to be
      // bound first. Use the current workspace if the memory doesn't have
      // one yet — otherwise the backend will reject the transition.
      if (m.scope === "conversation" && !m.project_root && workspaceRoot) {
        await api.memorySetContext(m.id, workspaceRoot, null);
      }
      await promoteMemory(m.id);
      await refresh();
    } catch (e) {
      setErr(`Promote failed: ${e}`);
    } finally {
      setBusy(null);
    }
  }

  async function demote(m: Memory) {
    setBusy(m.id);
    setErr(null);
    try {
      // Demoting global → project needs project_root; demoting project →
      // conversation needs conversation_id. Use current context as the
      // binding when the memory hasn't been bound previously.
      if (m.scope === "global" && !m.project_root && workspaceRoot) {
        await api.memorySetContext(m.id, workspaceRoot, null);
      } else if (
        m.scope === "project" &&
        !m.conversation_id &&
        conversationId != null
      ) {
        await api.memorySetContext(m.id, null, conversationId);
      }
      await demoteMemory(m.id);
      await refresh();
    } catch (e) {
      setErr(`Demote failed: ${e}`);
    } finally {
      setBusy(null);
    }
  }

  async function saveNew() {
    const content = newMemoryText.trim();
    if (!content) return;
    if (newMemoryScope === "project" && !workspaceRoot) {
      setErr("Project scope needs an active workspace.");
      return;
    }
    if (newMemoryScope === "conversation" && conversationId == null) {
      setErr("Conversation scope needs an open chat.");
      return;
    }
    setSavingNew(true);
    setErr(null);
    try {
      await saveMemory({
        content,
        conversationId:
          newMemoryScope === "conversation" ? conversationId : null,
        scope: newMemoryScope,
        projectRoot: newMemoryScope === "project" ? workspaceRoot : null,
        tags: "manual",
      });
      setNewMemoryText("");
      await refresh();
    } catch (e) {
      setErr(`Save failed: ${e}`);
    } finally {
      setSavingNew(false);
    }
  }

  // Apply scope chip filter on top of the active/inbox tab selection.
  const baseList = tab === "active" ? active : pending;
  const list = useMemo(
    () =>
      scopeFilter === "all"
        ? baseList
        : baseList.filter((m) => m.scope === scopeFilter),
    [baseList, scopeFilter],
  );

  const canSelectProject = !!workspaceRoot;
  const canSelectConversation = conversationId != null;

  return (
    <div className={`memory-panel ${open ? "open" : ""}`}>
      <button
        data-testid="memories-toggle"
        className="memory-toggle"
        onClick={() => setOpen(!open)}
      >
        <Star size={13} fill="currentColor" aria-hidden="true" />
        Memories
        <span className="memory-count">
          {active.length}
          {pending.length > 0 && ` · ${pending.length}!`}
        </span>
        <span className={`memory-chevron ${open ? "open" : ""}`}>▸</span>
      </button>

      {open && (
        <div className="memory-body" data-testid="memory-body">
          {/* Mode selector */}
          <div className="memory-mode-row">
            <label className="memory-mode-label">Mode</label>
            <select
              value={mode}
              onChange={(e) => changeMode(e.target.value as MemoryMode)}
            >
              {MODE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="memory-mode-desc" data-testid="memory-mode-desc">
            {MODE_OPTIONS.find((o) => o.value === mode)?.desc}
          </div>

          {/* Tabs */}
          <div className="memory-tabs">
            <button
              className={`memory-tab ${tab === "active" ? "active" : ""}`}
              onClick={() => setTab("active")}
            >
              Active <span className="memory-tab-count">{active.length}</span>
            </button>
            <button
              className={`memory-tab ${tab === "pending" ? "active" : ""}`}
              onClick={() => setTab("pending")}
            >
              Inbox <span className="memory-tab-count">{pending.length}</span>
            </button>
          </div>

          {/* Scope filter chips */}
          <div
            className="memory-scope-chips"
            data-testid="memory-scope-chips"
            role="tablist"
          >
            {(["all", "global", "project", "conversation"] as const).map(
              (s) => (
                <button
                  key={s}
                  role="tab"
                  aria-selected={scopeFilter === s}
                  data-testid={`scope-chip-${s}`}
                  className={`pill memory-scope-chip ${scopeFilter === s ? "active is-on" : ""}`}
                  onClick={() => setScopeFilter(s)}
                >
                  {s === "all" ? "All" : SCOPE_LABELS[s]}
                </button>
              ),
            )}
          </div>

          {/* Manual add row */}
          <div className="memory-new-row">
            <input
              data-testid="memory-new-input"
              className="memory-new-input"
              placeholder="Save a memory…"
              value={newMemoryText}
              onChange={(e) => setNewMemoryText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !savingNew) {
                  e.preventDefault();
                  saveNew();
                }
              }}
            />
            <select
              data-testid="memory-new-scope"
              className="memory-new-scope"
              value={newMemoryScope}
              onChange={(e) => setNewMemoryScope(e.target.value as MemoryScope)}
            >
              <option value="global">G — Global</option>
              <option value="project" disabled={!canSelectProject}>
                P — Project{canSelectProject ? "" : " (set workspace)"}
              </option>
              <option value="conversation" disabled={!canSelectConversation}>
                C — Conversation{canSelectConversation ? "" : " (open a chat)"}
              </option>
            </select>
            <button
              data-testid="memory-new-save"
              className="memory-btn"
              disabled={savingNew || !newMemoryText.trim()}
              onClick={saveNew}
            >
              Save
            </button>
          </div>

          {err && <ErrorBar message={err} onDismiss={() => setErr(null)} />}

          {/* List */}
          <div className="memory-list">
            {list.length === 0 &&
              (tab === "active" ? (
                <EmptyState
                  icon={<Star size={24} />}
                  heading={
                    scopeFilter === "all"
                      ? "No memories yet"
                      : "No memories at this scope"
                  }
                  sub={
                    scopeFilter === "all"
                      ? "Save one above, or let memory mode capture them as you chat."
                      : "Try a different scope filter, or save a memory above."
                  }
                  data-testid="memory-empty-active"
                />
              ) : (
                <EmptyState
                  icon={<Download size={24} />}
                  heading="Inbox empty"
                  sub="Memories awaiting your review will appear here."
                  data-testid="memory-empty-pending"
                />
              ))}
            {list.map((m) => {
              const up = nextUp(m.scope);
              const down = nextDown(m.scope);
              return (
                <div
                  key={m.id}
                  className="memory-item"
                  data-testid={`memory-item-${m.id}`}
                >
                  <span
                    className={`memory-scope-badge scope-${m.scope}`}
                    data-testid={`scope-badge-${m.id}`}
                    title={SCOPE_LABELS[m.scope]}
                  >
                    {SCOPE_LETTERS[m.scope]}
                  </span>
                  <div className="memory-item-content">{m.content}</div>
                  <div className="memory-item-actions">
                    {tab === "pending" ? (
                      <>
                        <button
                          className="memory-btn approve"
                          disabled={busy === m.id}
                          onClick={() => approve(m.id)}
                          title="Approve"
                        >
                          <Check size={14} />
                        </button>
                        <button
                          className="memory-btn reject"
                          disabled={busy === m.id}
                          onClick={() => reject(m.id)}
                          title="Reject"
                        >
                          <X size={14} />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="memory-btn promote"
                          disabled={busy === m.id || up === null}
                          onClick={() => promote(m)}
                          title={
                            up
                              ? `Promote → ${SCOPE_LABELS[up]}`
                              : "Already global"
                          }
                          aria-label="Promote memory"
                        >
                          ↑
                        </button>
                        <button
                          className="memory-btn demote"
                          disabled={busy === m.id || down === null}
                          onClick={() => demote(m)}
                          title={
                            down
                              ? `Demote → ${SCOPE_LABELS[down]}`
                              : "Already conversation"
                          }
                          aria-label="Demote memory"
                        >
                          ↓
                        </button>
                        <button
                          className="memory-btn delete"
                          disabled={busy === m.id}
                          onClick={() =>
                            deleteConfirm.request(String(m.id), () => {
                              void del(m.id);
                            })
                          }
                          title={
                            deleteConfirm.armed === String(m.id)
                              ? "Click again to confirm deletion"
                              : "Delete"
                          }
                          aria-label={
                            deleteConfirm.armed === String(m.id)
                              ? "Click again to confirm deletion"
                              : "Delete memory"
                          }
                        >
                          {deleteConfirm.armed === String(m.id) ? (
                            "Click again to confirm"
                          ) : (
                            <X size={14} />
                          )}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
