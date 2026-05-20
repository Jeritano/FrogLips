import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "./lib/tauri-api";
import type { Conversation, ServerStatus } from "./types";
import { ModelPicker } from "./components/ModelPicker";
import { ChatWindow } from "./components/ChatWindow";
import { MemoryPanel } from "./components/MemoryPanel";
import "./App.css";

function App() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [current, setCurrent] = useState<Conversation | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [memoryTick, setMemoryTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    refreshStatus();
    refreshConversations();
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    listen<ServerStatus>("server-status", (e) => setStatus(e.payload))
      .then((fn) => {
        if (cancelled) { fn(); } else { unlisten = fn; }
      })
      .catch(() => {/* event bus unavailable; rely on manual refresh */});
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    if (editingId !== null) editInputRef.current?.select();
  }, [editingId]);

  async function refreshStatus() {
    try {
      setStatus(await api.serverStatus());
    } catch {
      /* ignore */
    }
  }

  async function refreshConversations() {
    try {
      setConversations(await api.listConversations());
    } catch {
      /* ignore */
    }
  }

  function newChat() {
    setCurrent(null);
  }

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

  return (
    <div className="app">
      <aside className="sidebar">
        <button className="new-chat" onClick={newChat}>+ New chat</button>
        {err && (
          <div className="error-bar" onClick={() => setErr(null)} title="Click to dismiss">
            {err}
          </div>
        )}
        <ul className="conv-list">
          {conversations.map((c) => (
            <li
              key={c.id}
              className={current?.id === c.id ? "active" : ""}
              onClick={() => editingId !== c.id && setCurrent(c)}
              onDoubleClick={(e) => startEdit(c, e)}
              title="Double-click to rename"
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
                <span className="conv-title">{c.title}</span>
              )}
              <button
                className="del"
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteConv(c.id);
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <MemoryPanel refreshToken={memoryTick} />
      </aside>
      <main className="main">
        <header>
          <ModelPicker status={status} onStatusChange={setStatus} />
        </header>
        <ChatWindow
          status={status}
          conversation={current}
          onConversationCreated={(c) => {
            setCurrent(c);
            refreshConversations().catch(() => {});
          }}
          onMemoriesChanged={() => setMemoryTick((t) => t + 1)}
        />
      </main>
    </div>
  );
}

export default App;
