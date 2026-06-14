import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { api } from "../lib/tauri-api";
import { logDiag } from "../lib/diagnostics";
import { announce } from "../lib/announce";
import { parseTags, encodeTags, tagsFromInput } from "../lib/conversation-tags";
import { useCommitOnUnmount } from "./useCommitOnUnmount";
import type { Conversation } from "../types";

/** A conversation row annotated with its forest depth for sidebar indentation. */
export interface OrderedConversation {
  conv: Conversation;
  depth: number;
}

export interface UseConversationsResult {
  conversations: Conversation[];
  /** Ref mirror of `conversations` for `[]`-dep window-event handlers. */
  conversationsRef: React.MutableRefObject<Conversation[]>;
  refreshConversations: () => Promise<void>;
  editingId: number | null;
  editingTitle: string;
  setEditingTitle: Dispatch<SetStateAction<string>>;
  tagEditingId: number | null;
  tagDraft: string;
  setTagDraft: Dispatch<SetStateAction<string>>;
  convSearch: string;
  setConvSearch: Dispatch<SetStateAction<string>>;
  pendingDelete: {
    conv: Conversation;
    timer: ReturnType<typeof setTimeout>;
  } | null;
  setPendingDelete: Dispatch<
    SetStateAction<{
      conv: Conversation;
      timer: ReturnType<typeof setTimeout>;
    } | null>
  >;
  editInputRef: React.RefObject<HTMLInputElement | null>;
  filteredConversations: Conversation[];
  orderedConversations: OrderedConversation[];
  deleteConv: (id: number) => void;
  commitDelete: (id: number) => Promise<void>;
  undoDelete: () => void;
  togglePin: (c: Conversation, e: React.MouseEvent) => Promise<void>;
  startTagEdit: (c: Conversation, e: React.MouseEvent) => void;
  commitTagEdit: () => Promise<void>;
  cancelTagEdit: () => void;
  startEdit: (c: Conversation, e: React.MouseEvent) => void;
  commitEdit: () => Promise<void>;
  cancelEdit: () => void;
}

/**
 * Conversation-list subsystem extracted verbatim from `App`: list load,
 * search/filter, the BFS forest ordering, inline rename + tag editing, pin
 * toggle, and the 5s soft-delete-with-undo machinery (including the
 * unmount-commit safety net).
 *
 * `current` / `setCurrent` stay owned by `App` (they're shared with the model
 * picker, chat window, fork tree, etc.) and are injected here so the
 * conversation handlers can clear / rewrite the active selection exactly as
 * before. `setErr` surfaces failures into App's error bar.
 *
 * Behavior is identical to the inline implementation — same effect deps, same
 * optimistic updates, same announce() calls, same ordering. This is pure
 * extraction.
 */
export function useConversations(opts: {
  current: Conversation | null;
  setCurrent: Dispatch<SetStateAction<Conversation | null>>;
  setErr: Dispatch<SetStateAction<string | null>>;
}): UseConversationsResult {
  const { current, setCurrent, setErr } = opts;

  const [conversations, setConversations] = useState<Conversation[]>([]);
  // Ref mirror for window-event handlers registered with [] deps
  // (froglips:open-conversation) — they need the LATEST list without
  // re-subscribing per refresh.
  const conversationsRef = useRef<Conversation[]>([]);
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  // Conversation-id whose tag editor is open, plus its draft text.
  const [tagEditingId, setTagEditingId] = useState<number | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  // Content-search results: conversation ids whose messages match `convSearch`.
  // null = no content search performed (title-only filtering).
  const [contentMatchIds, setContentMatchIds] = useState<Set<number> | null>(
    null,
  );
  // Pending soft-delete. We delay the destructive IPC call by 5s so the undo
  // toast can cancel it — this preserves the conversation AND its messages.
  const [pendingDelete, setPendingDelete] = useState<{
    conv: Conversation;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const [convSearch, setConvSearch] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

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
      api
        .searchMessages(q)
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
            message:
              "searchMessages failed — falling back to title-only search",
            detail: err,
          });
        });
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
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
    const roots = filteredConversations.filter(
      (c) => c.parent_conv_id == null || !knownIds.has(c.parent_conv_id),
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

  return {
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
    filteredConversations,
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
  };
}
