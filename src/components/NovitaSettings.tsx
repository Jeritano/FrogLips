import { useEffect, useRef, useState } from "react";
import { api } from "../lib/tauri-api";

interface Props {
  onClose: () => void;
  onSaved?: () => void;
}

/**
 * Modal panel for managing the Novita.ai API key.
 *
 * The key itself lives in the OS keychain — this component never echoes the
 * stored key back to JS. It only knows whether a key is present (boolean)
 * and accepts new key input from the user.
 */
export function NovitaSettings({ onClose, onSaved }: Props) {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [newKey, setNewKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    api.novitaHasKey().then(setHasKey).catch((e) => setErr(String(e)));
    // Defer focus so the modal mount animation doesn't fight the cursor
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  // ESC to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function save() {
    const trimmed = newKey.trim();
    if (!trimmed) {
      setErr("Enter a key");
      return;
    }
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await api.novitaSetKey(trimmed);
      setNewKey("");
      setHasKey(true);
      setMsg("Saved to keychain. Testing connection…");
      try {
        await api.novitaTestConnection();
        setMsg("Key verified — Novita is reachable.");
        onSaved?.();
      } catch (e) {
        setMsg(null);
        setErr(`Saved, but test failed: ${e}`);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (!confirm("Remove the Novita API key from the keychain?")) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await api.novitaClearKey();
      setHasKey(false);
      setMsg("Key removed.");
      onSaved?.();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setErr(null);
    setMsg("Testing…");
    try {
      await api.novitaTestConnection();
      setMsg("Connection OK.");
    } catch (e) {
      setMsg(null);
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="agent-confirm-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="agent-confirm-box" style={{ maxWidth: 520 }}>
        <div className="agent-confirm-title">Novita (cloud) configuration</div>
        <p style={{ fontSize: 13, lineHeight: 1.45, margin: "8px 0 12px" }}>
          Novita.ai hosts open models like DeepSeek-R1, Qwen3, and Llama on
          their GPUs. Add an API key from{" "}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              api.openExternal("https://novita.ai/settings/key-management").catch(() => {});
            }}
          >
            novita.ai
          </a>
          {" "}to use them. The key is stored in your macOS Keychain — never in
          settings.json or the app database.
        </p>

        <div style={{ marginBottom: 10 }}>
          <strong>Status:</strong>{" "}
          {hasKey === null
            ? "checking…"
            : hasKey
              ? "key stored in keychain"
              : "no key configured"}
        </div>

        <label style={{ display: "block", fontSize: 13, marginBottom: 4 }}>
          {hasKey ? "Replace key" : "API key"}
        </label>
        <input
          ref={inputRef}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy) save();
          }}
          disabled={busy}
          placeholder="sk_..."
          style={{
            width: "100%",
            padding: "6px 8px",
            fontFamily: "monospace",
            fontSize: 13,
            boxSizing: "border-box",
          }}
        />

        {msg && <div style={{ marginTop: 8, fontSize: 12 }}>{msg}</div>}
        {err && <div className="error-bar" style={{ marginTop: 8 }}>{err}</div>}

        <div className="agent-confirm-actions" style={{ marginTop: 14 }}>
          {hasKey && (
            <button className="agent-confirm-deny" onClick={clear} disabled={busy}>
              Remove key
            </button>
          )}
          {hasKey && (
            <button className="agent-settings-btn" onClick={test} disabled={busy}>
              Test
            </button>
          )}
          <button className="agent-confirm-allow" onClick={save} disabled={busy || !newKey.trim()}>
            {hasKey ? "Replace" : "Save"}
          </button>
          <button className="agent-confirm-deny" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
