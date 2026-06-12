import { useCallback, useState } from "react";
import { api } from "../lib/tauri-api";
import { logDiag } from "../lib/diagnostics";
import { useTauriEvent } from "./useTauriEvent";
import type { AskUserRequest } from "../types";

export interface AskUserModal {
  askUserReq: AskUserRequest | null;
  askUserAnswer: string;
  setAskUserAnswer: (v: string) => void;
  submitAskUser: () => Promise<void>;
  cancelAskUser: () => Promise<void>;
}

/**
 * Agent `ask_user` modal. Listens for `ask-user` events and tracks the
 * pending request + draft answer. One modal at a time — a second request
 * before the first resolves replaces it (rare).
 */
export function useAskUserModal(onError: (msg: string) => void): AskUserModal {
  const [askUserReq, setAskUserReq] = useState<AskUserRequest | null>(null);
  const [askUserAnswer, setAskUserAnswer] = useState("");

  useTauriEvent<AskUserRequest>(
    "ask-user",
    useCallback((e) => {
      setAskUserReq(e.payload);
      setAskUserAnswer("");
    }, []),
  );

  const submitAskUser = useCallback(async () => {
    if (!askUserReq) return;
    const id = askUserReq.id;
    const answer = askUserAnswer.trim();
    setAskUserReq(null);
    setAskUserAnswer("");
    try {
      await api.agentAskUserReply(id, answer);
    } catch (e) {
      onError(`ask_user reply failed: ${e}`);
    }
  }, [askUserReq, askUserAnswer, onError]);

  const cancelAskUser = useCallback(async () => {
    if (!askUserReq) return;
    const id = askUserReq.id;
    setAskUserReq(null);
    setAskUserAnswer("");
    try {
      await api.agentAskUserCancel(id);
    } catch (err) {
      logDiag({
        level: "info",
        source: "chat-window",
        message: `cancelAskUser: backend cancel failed for ${id} (may have already resolved)`,
        detail: err,
      });
    }
  }, [askUserReq]);

  return {
    askUserReq,
    askUserAnswer,
    setAskUserAnswer,
    submitAskUser,
    cancelAskUser,
  };
}
