import { useEffect, useId, useState } from "react";
import { X } from "lucide-react";
import type { ConversationParams } from "../types";
import { emptyParams, paramsAreEmpty } from "../lib/conversation-params";

interface Props {
  /** Current persisted/active params for the conversation. */
  params: ConversationParams;
  /** Persist a new params set (all-null fields clear the override). */
  onSave: (next: ConversationParams) => void;
  /** Close the panel. */
  onClose: () => void;
  /** Disable inputs while a send is in flight. */
  disabled?: boolean;
}

/**
 * Compact per-conversation model-parameter editor. Each field is optional —
 * a blank input means "use the backend default", so an untouched panel
 * leaves behaviour identical to today. Reachable from the chat header.
 */
export function ParamsPanel({ params, onSave, onClose, disabled }: Props) {
  // Local draft so typing doesn't fire a DB write per keystroke; committed
  // on blur / explicit Apply.
  const [draft, setDraft] = useState<ConversationParams>(params);
  const idBase = useId();

  // Re-seed the draft when the conversation (and thus `params`) changes.
  useEffect(() => {
    setDraft(params);
  }, [params]);

  function commit(next: ConversationParams) {
    setDraft(next);
  }

  function setTemp(raw: string) {
    const n = raw.trim() === "" ? null : Number(raw);
    commit({
      ...draft,
      temperature: n != null && Number.isFinite(n) ? n : null,
    });
  }
  function setTopP(raw: string) {
    const n = raw.trim() === "" ? null : Number(raw);
    commit({ ...draft, top_p: n != null && Number.isFinite(n) ? n : null });
  }
  function setMaxTokens(raw: string) {
    const n = raw.trim() === "" ? null : Number(raw);
    commit({
      ...draft,
      max_tokens:
        n != null && Number.isFinite(n) ? Math.max(1, Math.floor(n)) : null,
    });
  }
  function setSystem(raw: string) {
    commit({ ...draft, system_prompt: raw.trim() === "" ? null : raw });
  }

  return (
    <div
      className="params-panel"
      data-testid="params-panel"
      role="group"
      aria-label="Conversation parameters"
    >
      <div className="params-panel-header">
        <span className="params-panel-title">Conversation parameters</span>
        <button
          type="button"
          className="agent-toggle"
          data-testid="params-panel-close"
          onClick={onClose}
          aria-label="Close parameters"
        >
          <X size={16} />
        </button>
      </div>
      <div className="params-panel-grid">
        <label className="params-field">
          <span>Temperature</span>
          <input
            type="number"
            data-testid="param-temperature"
            min={0}
            max={2}
            step={0.1}
            placeholder="default"
            disabled={disabled}
            value={draft.temperature ?? ""}
            onChange={(e) => setTemp(e.target.value)}
            aria-describedby={`${idBase}-temp-hint`}
          />
          <span id={`${idBase}-temp-hint`} className="params-hint">
            0–2
          </span>
        </label>
        <label className="params-field">
          <span>Top-p</span>
          <input
            type="number"
            data-testid="param-top-p"
            min={0}
            max={1}
            step={0.05}
            placeholder="default"
            disabled={disabled}
            value={draft.top_p ?? ""}
            onChange={(e) => setTopP(e.target.value)}
          />
          <span className="params-hint">0–1</span>
        </label>
        <label className="params-field">
          <span>Max tokens</span>
          <input
            type="number"
            data-testid="param-max-tokens"
            min={1}
            step={64}
            placeholder="default"
            disabled={disabled}
            value={draft.max_tokens ?? ""}
            onChange={(e) => setMaxTokens(e.target.value)}
          />
          <span className="params-hint">reply cap</span>
        </label>
      </div>
      <label className="params-field params-field-wide">
        <span>System prompt</span>
        <textarea
          data-testid="param-system-prompt"
          rows={3}
          placeholder="Optional — prepended to every turn in this conversation"
          disabled={disabled}
          value={draft.system_prompt ?? ""}
          onChange={(e) => setSystem(e.target.value)}
        />
      </label>
      <div className="params-panel-actions">
        <button
          type="button"
          className="agent-toggle"
          data-testid="params-reset"
          disabled={disabled || paramsAreEmpty(draft)}
          onClick={() => {
            const e = emptyParams();
            setDraft(e);
            onSave(e);
          }}
        >
          Reset to defaults
        </button>
        <button
          type="button"
          className="agent-toggle active"
          data-testid="params-apply"
          disabled={disabled}
          onClick={() => onSave(draft)}
        >
          Apply
        </button>
      </div>
    </div>
  );
}
