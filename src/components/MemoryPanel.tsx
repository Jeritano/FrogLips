import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/tauri-api";
import type { Memory, MemoryMode } from "../types";
import { getMemoryMode, setMemoryMode } from "../lib/memory-client";

interface Props {
  refreshToken?: number;
}

export function MemoryPanel({ refreshToken }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<Memory[]>([]);
  const [pending, setPending] = useState<Memory[]>([]);
  const [mode, setMode] = useState<MemoryMode>(getMemoryMode());
  const [tab, setTab] = useState<"active" | "pending">("active");
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [a, p] = await Promise.all([
        api.listMemories("active"),
        api.listMemories("pending"),
      ]);
      setActive(a);
      setPending(p);
    } catch {/* ignore */}
  }, []);

  useEffect(() => { if (open) refresh(); }, [open, refreshToken, refresh]);

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
    } catch (e) { setErr(`Approve failed: ${e}`); }
    finally { setBusy(null); }
  }

  async function reject(id: number) {
    setBusy(id);
    setErr(null);
    try {
      await api.deleteMemory(id);
      await refresh();
    } catch (e) { setErr(`Reject failed: ${e}`); }
    finally { setBusy(null); }
  }

  async function del(id: number) {
    setBusy(id);
    setErr(null);
    try {
      await api.deleteMemory(id);
      await refresh();
    } catch (e) { setErr(`Delete failed: ${e}`); }
    finally { setBusy(null); }
  }

  const list = tab === "active" ? active : pending;

  return (
    <div className={`memory-panel ${open ? "open" : ""}`}>
      <button data-testid="memories-toggle" className="memory-toggle" onClick={() => setOpen(!open)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
        Memories
        <span className="memory-count">{active.length}{pending.length > 0 && ` · ${pending.length}!`}</span>
        <span className={`memory-chevron ${open ? "open" : ""}`}>▸</span>
      </button>

      {open && (
        <div className="memory-body" data-testid="memory-body">
          {/* Mode selector */}
          <div className="memory-mode-row">
            <label className="memory-mode-label">Mode</label>
            <select value={mode} onChange={(e) => changeMode(e.target.value as MemoryMode)}>
              <option value="off">Off</option>
              <option value="manual">Manual pin only</option>
              <option value="queue">Auto-extract → queue</option>
              <option value="direct">Auto-extract → direct</option>
            </select>
          </div>

          {/* Tabs */}
          <div className="memory-tabs">
            <button className={`memory-tab ${tab === "active" ? "active" : ""}`} onClick={() => setTab("active")}>
              Active <span className="memory-tab-count">{active.length}</span>
            </button>
            <button className={`memory-tab ${tab === "pending" ? "active" : ""}`} onClick={() => setTab("pending")}>
              Inbox <span className="memory-tab-count">{pending.length}</span>
            </button>
          </div>

          {err && (
            <div className="error-bar" onClick={() => setErr(null)} title="Click to dismiss">{err}</div>
          )}

          {/* List */}
          <div className="memory-list">
            {list.length === 0 && (
              <div className="memory-empty">
                {tab === "active" ? "No memories yet. Pin messages or enable auto-extract." : "Inbox empty."}
              </div>
            )}
            {list.map((m) => (
              <div key={m.id} className="memory-item">
                <div className="memory-item-content">{m.content}</div>
                <div className="memory-item-actions">
                  {tab === "pending" ? (
                    <>
                      <button className="memory-btn approve" disabled={busy === m.id} onClick={() => approve(m.id)} title="Approve">✓</button>
                      <button className="memory-btn reject" disabled={busy === m.id} onClick={() => reject(m.id)} title="Reject">✕</button>
                    </>
                  ) : (
                    <button className="memory-btn delete" disabled={busy === m.id} onClick={() => del(m.id)} title="Delete">✕</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
