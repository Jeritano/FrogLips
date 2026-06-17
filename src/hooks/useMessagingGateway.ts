/* ── useMessagingGateway ─────────────────────────────────────────────────────
 *
 * Mounted once (in App). Bridges the Rust messaging gateway to the agent loop:
 *   • starts/stops the Rust gateway when the Telegram channel is enabled/disabled
 *   • listens for `messaging://inbound` events
 *   • runs the agent for each accepted message under the SAFE_REMOTE_TOOLS policy
 *     (read-only tools, unattended-deny confirmation) and replies via messagingSend
 *
 * Remote input is untrusted: the run is double-locked (allowlist + deny-all
 * confirm) and bounded (short iteration cap, per-chat rolling history). Messages
 * are processed serially so concurrent inbound traffic can't interleave runs.
 */

import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../lib/tauri-api";
import { useSettingsField } from "../contexts/SettingsContext";
import { SAFE_REMOTE_TOOLS, REMOTE_RUN_SYSTEM_NOTE } from "../lib/messaging-policy";
import { logDiag } from "../lib/diagnostics";
import type { Message, ServerStatus } from "../types";
import type { AgentBackend } from "../lib/agent-loop/types";

interface Inbound {
  channel: string;
  chatId: number;
  messageId: number;
  senderId: number;
  senderName: string;
  text: string;
}

const HISTORY_CAP = 20; // rolling per-chat context (messages), bounds prompt size
const MAX_ITERS = 12; // bound a remote run's tool turns

function resolveBackend(backend: string | null): AgentBackend {
  return backend === "mlx" ||
    backend === "native" ||
    backend === "custom" ||
    backend === "openrouter"
    ? backend
    : "ollama";
}

/** Stable synthetic conversation id for a chat (negative → never collides with
 *  the positive autoincrement ids of real conversations). */
function convIdFor(chatId: number): number {
  return -(1_000_000 + (Math.abs(Math.trunc(chatId)) % 1_000_000));
}

export function useMessagingGateway(status: ServerStatus | null) {
  const telegramEnabled = useSettingsField(
    (s) => s?.messaging?.telegram?.enabled === true,
  );
  // Latest status in a ref so the (stable) inbound handler always sees current
  // model/backend without re-subscribing the listener on every status change.
  const statusRef = useRef<ServerStatus | null>(status);
  statusRef.current = status;
  const histRef = useRef<Map<number, Message[]>>(new Map());
  const queueRef = useRef<Inbound[]>([]);
  const drainingRef = useRef(false);

  // Start / stop the Rust gateway as the channel toggles.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (telegramEnabled && (await api.messagingHasToken())) {
          await api.messagingStart();
          if (!cancelled)
            logDiag({
              level: "info",
              source: "messaging",
              message: "Telegram gateway started",
            });
        } else {
          await api.messagingStop();
        }
      } catch (e) {
        if (!cancelled)
          logDiag({
            level: "warn",
            source: "messaging",
            message: "gateway start/stop failed",
            detail: String(e),
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [telegramEnabled]);

  // Subscribe to inbound messages once.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;

    const drain = async () => {
      if (drainingRef.current) return;
      drainingRef.current = true;
      try {
        while (queueRef.current.length > 0) {
          const msg = queueRef.current.shift()!;
          await handleInbound(msg);
        }
      } finally {
        drainingRef.current = false;
      }
    };

    const handleInbound = async (m: Inbound) => {
      const st = statusRef.current;
      if (!st?.running || !st.model) {
        await api
          .messagingSend(
            m.chatId,
            "Froglips has no model loaded right now — open the app and load a model, then try again.",
          )
          .catch(() => undefined);
        return;
      }
      const history = histRef.current.get(m.chatId) ?? [];
      const userMsg: Message = {
        conversation_id: convIdFor(m.chatId),
        role: "user",
        content: m.text,
      };
      const msgs = [...history, userMsg].slice(-HISTORY_CAP);
      try {
        const { runAgentLoop } = await import("../lib/agent-loop");
        const ctrl = new AbortController();
        const finalText = await runAgentLoop({
          model: st.model,
          messages: msgs,
          conversationId: convIdFor(m.chatId),
          workspaceRoot: null,
          backend: resolveBackend(st.backend),
          serverStatus: st,
          // SAFETY: remote runs are locked to read-only tools + deny-all confirm.
          toolAllowlist: [...SAFE_REMOTE_TOOLS],
          systemPromptOverride: REMOTE_RUN_SYSTEM_NOTE,
          maxIterations: MAX_ITERS,
          computerUseEnabled: false,
          disabledTools: [],
          onUpdate: () => {},
          onStatusChange: () => {},
          requestConfirmation: async () => ({
            approve: false,
            reason: "unattended_denied" as const,
          }),
          signal: ctrl.signal,
        });
        const reply = (finalText ?? "").trim() || "(no response)";
        // Persist rolling history (user + assistant) for cross-message context.
        const next = [
          ...msgs,
          {
            conversation_id: convIdFor(m.chatId),
            role: "assistant" as const,
            content: reply,
          },
        ].slice(-HISTORY_CAP);
        histRef.current.set(m.chatId, next);
        await api.messagingSend(m.chatId, reply);
      } catch (e) {
        logDiag({
          level: "warn",
          source: "messaging",
          message: "remote agent run failed",
          detail: String(e),
        });
        await api
          .messagingSend(m.chatId, "⚠️ Sorry — something went wrong handling that.")
          .catch(() => undefined);
      }
    };

    listen<Inbound>("messaging://inbound", (ev) => {
      if (disposed) return;
      queueRef.current.push(ev.payload);
      void drain();
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
