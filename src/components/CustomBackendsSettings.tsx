import { useCallback, useEffect, useState } from "react";
import {
  useSettingsGetter,
  useUpdateSettings,
} from "../contexts/SettingsContext";
import { useTwoClickConfirm } from "../lib/use-two-click-confirm";
import { ErrorBar } from "./ErrorBar";
import { Cloud } from "lucide-react";
import type { CustomBackend } from "../types";

/* ── Custom OpenAI-compatible cloud backends ──────────────────────────── */
/*
 * Add/edit/remove cloud endpoints that speak the OpenAI
 * `/v1/chat/completions` API — OpenRouter, Groq, Cerebras, Together,
 * DeepInfra, Fireworks, a self-hosted vLLM, etc. Each backend stores a
 * base_url + model + (optionally) an API key. The key is written to the
 * macOS Keychain by the Rust `settings_set` path and never round-trips
 * back to the webview in cleartext — `settingsGet` returns the redacted
 * marker, so a saved-but-unedited key shows as "set".
 *
 * Chat routing: a configured backend appears in the model picker under
 * "Custom (cloud)"; selecting it routes turns through the Rust
 * `custom_chat_stream` command (see custom-client.ts).
 */

interface Props {
  /** Fires after a save so a parent can refresh if needed. */
  onChanged?: () => void;
}

const REDACTED = "__keychain__";

/** Stable, human-readable id slug from a display name. Keeps the picker +
 *  status.model value readable instead of a uuid. Collisions are guarded
 *  against in `addOrUpdate`. */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "backend"
  );
}

export function CustomBackendsSettings({ onChanged }: Props) {
  const [backends, setBackends] = useState<CustomBackend[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftUrl, setDraftUrl] = useState("");
  const [draftModel, setDraftModel] = useState("");
  const [draftKey, setDraftKey] = useState("");
  const removeConfirm = useTwoClickConfirm();
  // Read/write through the central settings store. The editor keeps a local
  // working copy (`backends`) so edits apply optimistically; the store is the
  // canonical source it hydrates from on mount and re-reads on a failed save.
  const getSettings = useSettingsGetter();
  const updateSettings = useUpdateSettings();

  const refresh = useCallback(async () => {
    try {
      const s = await getSettings();
      setBackends(s.custom_backends ?? []);
    } catch (e) {
      setErr(String(e));
    }
  }, [getSettings]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function persist(next: CustomBackend[]) {
    setBackends(next);
    try {
      await updateSettings({ custom_backends: next });
      onChanged?.();
    } catch (e) {
      setErr(`Failed to save: ${e}`);
      void refresh();
    }
  }

  function resetDraft() {
    setDraftName("");
    setDraftUrl("");
    setDraftModel("");
    setDraftKey("");
    setShowKey(false);
    setAdding(false);
  }

  function addBackend() {
    setErr(null);
    const name = draftName.trim();
    const base_url = draftUrl.trim().replace(/\/+$/, "");
    const model = draftModel.trim();
    if (!name || !base_url || !model) {
      setErr("Name, base URL, and model are required.");
      return;
    }
    if (!/^https?:\/\//i.test(base_url)) {
      setErr("Base URL must start with http:// or https://");
      return;
    }
    // Derive a unique id slug.
    let id = slugify(name);
    if (backends.some((b) => b.id === id)) {
      let n = 2;
      while (backends.some((b) => b.id === `${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    const key = draftKey.trim();
    const cb: CustomBackend = {
      id,
      name,
      base_url,
      model,
      // Send the plaintext key ONCE on save → Rust writes it to Keychain
      // and blanks the on-disk copy. Empty = no key (some local/self-hosted
      // endpoints need none).
      api_key: key.length > 0 ? key : null,
    };
    void persist([...backends, cb]);
    resetDraft();
  }

  function removeBackend(id: string) {
    void persist(backends.filter((b) => b.id !== id));
  }

  return (
    <div style={{ marginTop: 8 }}>
      <div className="agent-settings-row">
        <span className="agent-settings-label">Custom cloud backends:</span>
        <span className="agent-settings-hint">
          Any OpenAI-compatible endpoint (OpenRouter, Groq, Cerebras,
          Together…). The API key is stored in the macOS Keychain, never on
          disk.
        </span>
      </div>

      {backends.length === 0 && (
        <div className="agent-settings-hint" style={{ padding: "4px 0 8px 0" }}>
          None configured. Example: name <code>OpenRouter</code>, URL{" "}
          <code>https://openrouter.ai/api</code>, model{" "}
          <code>meta-llama/llama-3.3-70b-instruct</code>.
        </div>
      )}

      {backends.map((b) => {
        const hasKey =
          b.api_key === REDACTED || (b.api_key != null && b.api_key.length > 0);
        return (
          <div
            key={b.id}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: 8,
              marginBottom: 8,
              background: "var(--surface)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <strong style={{ fontSize: 13 }}>
                <Cloud size={16} /> {b.name}
              </strong>
              <span className="agent-settings-hint" style={{ fontSize: 11 }}>
                {hasKey ? "key set" : "no key"}
              </span>
              <div style={{ marginLeft: "auto" }}>
                <button
                  className="agent-settings-btn"
                  onClick={() =>
                    removeConfirm.request(b.id, (id) => removeBackend(id))
                  }
                >
                  {removeConfirm.labelFor(b.id, "Remove")}
                </button>
              </div>
            </div>
            <div
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                padding: "4px 0",
              }}
            >
              <code>{b.base_url}/v1/chat/completions</code> · model{" "}
              <code>{b.model}</code>
            </div>
          </div>
        );
      })}

      {!adding ? (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          <button className="agent-settings-btn" onClick={() => setAdding(true)}>
            + Add cloud backend
          </button>
          <button
            className="agent-settings-btn"
            title="Nous Portal — OpenAI-compatible access to Hermes + 300+ models. Add your Nous API key."
            onClick={() => {
              // Base URL has NO /v1 — custom_chat_stream appends
              // /v1/chat/completions (custom_backend.rs). Model + key are
              // left for the user (their Nous Portal model id + API key).
              setDraftName("Nous Portal");
              setDraftUrl("https://inference-api.nousresearch.com");
              setDraftModel("Hermes-4");
              setDraftKey("");
              setAdding(true);
            }}
          >
            + Nous Portal
          </button>
        </div>
      ) : (
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: 8,
            background: "var(--surface)",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <input
            placeholder="name (e.g. OpenRouter)"
            aria-label="Custom backend name"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            style={inputStyle}
          />
          <input
            placeholder="base URL (e.g. https://openrouter.ai/api)"
            aria-label="Custom backend base URL"
            value={draftUrl}
            onChange={(e) => setDraftUrl(e.target.value)}
            style={inputStyle}
          />
          <input
            placeholder="model id (e.g. meta-llama/llama-3.3-70b-instruct)"
            aria-label="Custom backend model id"
            value={draftModel}
            onChange={(e) => setDraftModel(e.target.value)}
            style={inputStyle}
          />
          <div style={{ display: "flex", gap: 4 }}>
            <input
              type={showKey ? "text" : "password"}
              placeholder="API key (stored in Keychain; blank if none)"
              aria-label="Custom backend API key"
              value={draftKey}
              onChange={(e) => setDraftKey(e.target.value)}
              style={{ ...inputStyle, flex: 1 }}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="agent-settings-btn"
              onClick={() => setShowKey((v) => !v)}
              aria-label={showKey ? "Hide API key" : "Show API key"}
            >
              {showKey ? "Hide" : "Show"}
            </button>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            The base URL must NOT include <code>/v1/chat/completions</code> —
            that's appended automatically.
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <button className="agent-settings-btn" onClick={addBackend}>
              Add
            </button>
            <button
              className="agent-settings-btn"
              onClick={() => {
                resetDraft();
                setErr(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <ErrorBar message={err} onDismiss={() => setErr(null)} />
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--bg)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  padding: "4px 6px",
  fontSize: 12,
  fontFamily: "inherit",
};
