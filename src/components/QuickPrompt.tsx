import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { logDiag } from "../lib/diagnostics";

/**
 * Menu-bar quick prompt. Strict ephemeral — no persistence, no history.
 * Lifecycle:
 *  1. Window mounts, textarea auto-focuses.
 *  2. Enter (no shift) submits → invoke `quick_prompt_submit(op_id, text)`.
 *  3. Backend streams chunks on `quick-prompt-response:{op_id}` until done.
 *  4. Show Copy / Open-in-main buttons. Esc hides the window.
 */

interface ChunkEvent {
  op_id: string;
  delta: string;
  done: boolean;
  error: string | null;
}

type Phase = "idle" | "streaming" | "done" | "error";

export function QuickPrompt() {
  const [text, setText] = useState("");
  const [reply, setReply] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [err, setErr] = useState<string | null>(null);
  const opIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-focus on mount and whenever we transition back to idle (re-open).
  useEffect(() => {
    inputRef.current?.focus();
  }, [phase]);

  // Global Esc to hide. Window is kept alive between invocations so we
  // don't re-pay the WebviewWindow cold-start.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        invoke("quick_prompt_hide").catch((err) =>
          logDiag({
            level: "info",
            source: "quick-prompt",
            message: "Esc → quick_prompt_hide failed",
            detail: err,
          }),
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Clean up streaming listener on unmount.
  useEffect(() => {
    return () => {
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    };
  }, []);

  async function submit() {
    const prompt = text.trim();
    if (!prompt || phase === "streaming") return;
    const opId = `qp-${crypto.randomUUID()}`;
    opIdRef.current = opId;
    setReply("");
    setErr(null);
    setPhase("streaming");

    // Listen first so we don't miss the leading chunks (backend may emit
    // synchronously after the invoke resolves the future scheduler).
    try {
      const off = await listen<ChunkEvent>(
        `quick-prompt-response:${opId}`,
        (e) => {
          const c = e.payload;
          if (c.error) {
            setErr(c.error);
            setPhase("error");
            return;
          }
          if (c.delta) {
            setReply((prev) => prev + c.delta);
          }
          if (c.done) {
            setPhase((p) => (p === "error" ? p : "done"));
          }
        },
      );
      unlistenRef.current = off;
    } catch (e) {
      setErr(`listen failed: ${e}`);
      setPhase("error");
      return;
    }

    try {
      await invoke("quick_prompt_submit", { opId, text: prompt });
    } catch (e) {
      setErr(String(e));
      setPhase("error");
    }
  }

  function reset() {
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    setText("");
    setReply("");
    setErr(null);
    setPhase("idle");
  }

  async function copyReply() {
    try {
      await navigator.clipboard.writeText(reply);
    } catch {
      /* best effort */
    }
  }

  async function openInMain() {
    // Surface result in the main chat. ChatWindow already toasts via
    // `quick-prompt-completed`; this just brings the main window forward
    // and hides ours. Strict v1.3: no auto-message-creation.
    try { await navigator.clipboard.writeText(reply); } catch (err) {
      logDiag({
        level: "info",
        source: "quick-prompt",
        message: "openInMain: clipboard write failed",
        detail: err,
      });
    }
    try { await invoke("quick_prompt_hide"); } catch (err) {
      logDiag({
        level: "warn",
        source: "quick-prompt",
        message: "openInMain: quick_prompt_hide invoke failed",
        detail: err,
      });
    }
  }

  return (
    <div className="quick-root">
      <div className="quick-input-wrap">
        <textarea
          ref={inputRef}
          className="quick-input"
          placeholder="Ask Froglips…  (Enter = send, Shift+Enter = newline, Esc = close)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={phase === "streaming"}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={2}
          autoFocus
          spellCheck={false}
        />
        <button
          type="button"
          className="quick-send"
          onClick={submit}
          disabled={!text.trim() || phase === "streaming"}
          title="Send (Enter)"
        >
          {phase === "streaming" ? "…" : "Send"}
        </button>
      </div>

      {(phase === "streaming" || phase === "done" || phase === "error") && (
        <div className="quick-reply" data-testid="quick-reply">
          {err ? (
            <div className="quick-error">{err}</div>
          ) : (
            <pre className="quick-reply-text">{reply || (phase === "streaming" ? "…" : "(empty)")}</pre>
          )}
          {(phase === "done" || phase === "error") && (
            <div className="quick-actions">
              <button type="button" onClick={copyReply} disabled={!reply}>Copy</button>
              <button type="button" onClick={openInMain}>Open in main app</button>
              <button type="button" onClick={reset}>New</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
