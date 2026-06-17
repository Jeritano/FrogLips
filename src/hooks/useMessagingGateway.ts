/* ── useMessagingGateway ─────────────────────────────────────────────────────
 *
 * Mounted once (in App). Bridges the Rust multi-channel messaging gateway to the
 * agent loop:
 *   • starts/stops each channel's Rust gateway as its enable flag toggles
 *   • listens for `messaging://inbound` events from any channel
 *   • runs the agent for each accepted message under the SAFE_REMOTE_TOOLS policy
 *     (read-only tools, unattended-deny confirmation) and replies via messagingSend
 *
 * Remote input is untrusted: runs are double-locked (allowlist enforced Rust-side
 * + safe-tools allowlist + deny-all confirm) and bounded (short iteration cap,
 * rolling per-conversation history). Messages are processed serially.
 */

import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../lib/tauri-api";
import { useSettingsField } from "../contexts/SettingsContext";
import { SAFE_REMOTE_TOOLS, REMOTE_RUN_SYSTEM_NOTE } from "../lib/messaging-policy";
import { logDiag } from "../lib/diagnostics";
import type { Message, MessagingConfig, ServerStatus } from "../types";
import type { AgentBackend } from "../lib/agent-loop/types";

interface Inbound {
  channel: string;
  target: string;
  sender: string;
  senderName: string;
  text: string;
}

const HISTORY_CAP = 20;
const MAX_ITERS = 12;
const CHANNELS = [
  "telegram",
  "matrix",
  "discord",
  "slack",
  "mattermost",
  "email",
] as const;

function resolveBackend(backend: string | null): AgentBackend {
  return backend === "mlx" ||
    backend === "native" ||
    backend === "custom" ||
    backend === "openrouter"
    ? backend
    : "ollama";
}

/** Stable negative synthetic conversation id from a "channel:target" key (never
 *  collides with the positive autoincrement ids of real conversations). */
function convIdFor(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return -(1_000_000 + (Math.abs(h) % 100_000_000));
}

export function useMessagingGateway(status: ServerStatus | null) {
  const messaging = useSettingsField<MessagingConfig | null | undefined>(
    (s) => s?.messaging,
  );
  const statusRef = useRef<ServerStatus | null>(status);
  statusRef.current = status;
  const histRef = useRef<Map<string, Message[]>>(new Map());
  const queueRef = useRef<Inbound[]>([]);
  const drainingRef = useRef(false);

  // Start / stop each channel as its enable flag changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const ch of CHANNELS) {
        const cfg = (messaging as Record<string, { enabled?: boolean }> | null)?.[ch];
        const enabled = cfg?.enabled === true;
        try {
          if (enabled && (await api.messagingHasToken(ch))) {
            await api.messagingStart(ch);
          } else {
            await api.messagingStop(ch);
          }
        } catch (e) {
          if (!cancelled)
            logDiag({
              level: "warn",
              source: "messaging",
              message: `gateway ${ch} start/stop failed`,
              detail: String(e),
            });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messaging]);

  // Subscribe to inbound messages once.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;

    const drain = async () => {
      if (drainingRef.current) return;
      drainingRef.current = true;
      try {
        while (queueRef.current.length > 0) {
          await handleInbound(queueRef.current.shift()!);
        }
      } finally {
        drainingRef.current = false;
      }
    };

    const handleInbound = async (m: Inbound) => {
      const st = statusRef.current;
      const key = `${m.channel}:${m.target}`;
      if (!st?.running || !st.model) {
        await api
          .messagingSend(
            m.channel,
            m.target,
            "Froglips has no model loaded right now — open the app and load a model, then try again.",
          )
          .catch(() => undefined);
        return;
      }
      const history = histRef.current.get(key) ?? [];
      const convId = convIdFor(key);
      const userMsg: Message = {
        conversation_id: convId,
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
          conversationId: convId,
          workspaceRoot: null,
          backend: resolveBackend(st.backend),
          serverStatus: st,
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
        histRef.current.set(
          key,
          [
            ...msgs,
            { conversation_id: convId, role: "assistant" as const, content: reply },
          ].slice(-HISTORY_CAP),
        );
        await api.messagingSend(m.channel, m.target, reply);
      } catch (e) {
        logDiag({
          level: "warn",
          source: "messaging",
          message: "remote agent run failed",
          detail: String(e),
        });
        await api
          .messagingSend(m.channel, m.target, "⚠️ Sorry — something went wrong handling that.")
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
