import { useState, type Dispatch, type SetStateAction } from "react";
import { api } from "../lib/tauri-api";
import { logDiag } from "../lib/diagnostics";
import { useEvent } from "./useEvent";
import type { Conversation, Message } from "../types";

/** Draft state for the edit-and-retry modal: the message being edited + text. */
export interface EditState {
  msg: Message;
  text: string;
}

export interface UseMessageActionsResult {
  editState: EditState | null;
  setEditState: Dispatch<SetStateAction<EditState | null>>;
  /** Re-run the last user→assistant exchange (truncate + resend). */
  onRegenerate: () => Promise<void>;
  /** Open the edit-and-retry modal seeded with the user message's text. */
  onEditUser: (msg: Message) => void;
  /** Submit the edit modal: truncate from the edited message on and resend. */
  submitEdit: () => Promise<void>;
  /** Fork the conversation at the given message. */
  onForkMsg: (msg: Message) => Promise<void>;
}

/**
 * Per-message action handlers extracted verbatim from `ChatWindow`: regenerate
 * (re-run the last reply), edit-and-retry (open modal → truncate → resend), and
 * fork-at-message. All four are wrapped in `useEvent` so their identity stays
 * fixed for `MessageRow`'s `React.memo` (an inline arrow would bust the row
 * memo on every streaming rAF frame) while the body always observes the latest
 * props — identical to the inline implementation.
 *
 * The deps are injected from ChatWindow: the live `messages` snapshot, the
 * `resend`/`setMessages` plumbing from `useChatSend`, the `isWorking` guard,
 * the active `conversation`, `setErr` for the error bar, and the optional
 * `onForked` host callback.
 */
export function useMessageActions(deps: {
  messages: Message[];
  conversation: Conversation | null;
  isWorking: boolean;
  resend: (text: string, base: Message[]) => Promise<void>;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setErr: Dispatch<SetStateAction<string | null>>;
  onForked?: (newConvId: number) => void;
}): UseMessageActionsResult {
  const {
    messages,
    conversation,
    isWorking,
    resend,
    setMessages,
    setErr,
    onForked,
  } = deps;

  // Edit-and-retry: holds the user message being edited plus its draft text.
  const [editState, setEditState] = useState<EditState | null>(null);

  // Stable handler identity for MessageRow's React.memo — `useEvent` keeps the
  // reference fixed while the body always sees the latest state.
  const onRegenerate = useEvent(async () => {
    if (isWorking || !conversation) return;
    let lastUserIdx = -1;
    let lastAsstIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (
        lastAsstIdx === -1 &&
        m.role === "assistant" &&
        !m.tool_calls?.length
      ) {
        lastAsstIdx = i;
      } else if (lastAsstIdx !== -1 && lastUserIdx === -1 && m.role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1 || lastAsstIdx === -1) return;
    const userText = messages[lastUserIdx].content;
    for (let i = lastUserIdx; i <= lastAsstIdx; i++) {
      const id = messages[i]?.id;
      if (id != null) {
        try {
          await api.deleteMessage(id);
        } catch (err) {
          logDiag({
            level: "warn",
            source: "chat-window",
            message: `regenerate: deleteMessage(${id}) failed — proceeding anyway`,
            detail: err,
          });
        }
      }
    }
    const truncated = messages
      .slice(0, lastUserIdx)
      .concat(messages.slice(lastAsstIdx + 1));
    setMessages(truncated);
    await resend(userText, truncated);
  });

  // Edit-and-retry. Opens a small editor seeded with the user message's
  // current text; on submit we truncate everything from that message onward
  // (mirroring regenerate) and resend with the edited text.
  const onEditUser = useEvent((msg: Message) => {
    if (isWorking) return;
    setEditState({ msg, text: msg.content });
  });

  const submitEdit = useEvent(async () => {
    if (!editState || isWorking || !conversation) return;
    const { msg, text } = editState;
    const newText = text.trim();
    setEditState(null);
    if (!newText) return;
    const editIdx = messages.findIndex(
      (m) =>
        (msg.id != null && m.id === msg.id) ||
        (msg._tmpKey && m._tmpKey === msg._tmpKey),
    );
    if (editIdx === -1) return;
    // Delete the edited user message and everything after it from the DB.
    for (let i = editIdx; i < messages.length; i++) {
      const id = messages[i]?.id;
      if (id != null) {
        try {
          await api.deleteMessage(id);
        } catch (err) {
          logDiag({
            level: "warn",
            source: "chat-window",
            message: `edit: deleteMessage(${id}) failed — proceeding anyway`,
            detail: err,
          });
        }
      }
    }
    const truncated = messages.slice(0, editIdx);
    setMessages(truncated);
    await resend(newText, truncated);
  });

  // Stable handler for MessageList → MessageRow (React.memo). An inline arrow
  // here would bust the row memo on every parent render (one per streaming
  // rAF frame) and undo the windowing perf work. `useEvent` keeps the
  // reference fixed while the body always observes the latest props.
  const onForkMsg = useEvent(async (msg: Message) => {
    if (!conversation?.id || msg.id == null) return;
    try {
      const newId = await api.conversationFork(conversation.id, msg.id);
      onForked?.(newId);
    } catch (e) {
      setErr(`Fork failed: ${e}`);
    }
  });

  return {
    editState,
    setEditState,
    onRegenerate,
    onEditUser,
    submitEdit,
    onForkMsg,
  };
}
