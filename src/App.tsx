import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { api } from "./lib/tauri-api";
import { configureMemory } from "./lib/memory-client";
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
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [convSearch, setConvSearch] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    refreshStatus();
    refreshConversations();
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
        } catch {/* ignore */}
      }
    }).catch(() => {/* ignore */});

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
        } catch {/* ignore */}
      }, 500);
    };
    const offResize = win.onResized(persistGeometry);
    const offMove = win.onMoved(persistGeometry);

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
      offResize.then((f) => f()).catch(() => {});
      offMove.then((f) => f()).catch(() => {});
      if (saveTimer) window.clearTimeout(saveTimer);
    };
  }, []);

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

  function toggleTheme() {
    const next: "dark" | "light" = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    api.settingsSet({ theme: next }).catch(() => {});
  }

  const filteredConversations = conversations.filter((c) =>
    !convSearch.trim() || c.title.toLowerCase().includes(convSearch.trim().toLowerCase()),
  );

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
          {filteredConversations.map((c) => (
            <li
              key={c.id}
              data-testid="conv-item"
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
