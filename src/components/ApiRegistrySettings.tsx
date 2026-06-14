import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import {
  useSettingsGetter,
  useUpdateSettings,
} from "../contexts/SettingsContext";
import type { SavedApi } from "../types";

/*
 * Saved-API registry editor (Settings → APIs, 2026-06-11). Lets the user
 * register named external APIs the agent can call via the `call_api` tool.
 * The key is written to the Keychain on save (settings.rs redacts it on
 * disk); the model only ever references the API by name and never sees the
 * secret. The redacted marker round-trips so re-saving without retyping the
 * key leaves it untouched.
 */

const REDACTED = "__keychain__";

function blankDraft(): SavedApi {
  return {
    id: `api-${crypto.randomUUID().slice(0, 8)}`,
    name: "",
    base_url: "",
    auth_header: "Authorization",
    auth_template: "Bearer {key}",
    description: "",
    api_key: "",
  };
}

export function ApiRegistrySettings() {
  const [apis, setApis] = useState<SavedApi[]>([]);
  const [draft, setDraft] = useState<SavedApi | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const getSettings = useSettingsGetter();
  const updateSettings = useUpdateSettings();

  useEffect(() => {
    void getSettings()
      .then((s) => setApis(s.saved_apis ?? []))
      .catch(() => {});
  }, [getSettings]);

  async function persist(next: SavedApi[]) {
    setApis(next);
    try {
      // Outbound keeps real/typed keys for entries being saved; redacted
      // marker for untouched ones (settings.rs leaves Keychain as-is on it).
      await updateSettings({ saved_apis: next });
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }

  function save() {
    if (!draft) return;
    if (!draft.name.trim() || !draft.base_url.trim()) {
      setErr("Name and base URL are required.");
      return;
    }
    if (!/^https?:\/\//i.test(draft.base_url.trim())) {
      setErr("Base URL must start with http(s)://");
      return;
    }
    const cleaned: SavedApi = {
      ...draft,
      name: draft.name.trim(),
      base_url: draft.base_url.trim(),
      // Empty key field on an EDIT means "leave the stored key alone".
      api_key: draft.api_key ? draft.api_key : REDACTED,
    };
    const exists = apis.some((a) => a.id === cleaned.id);
    void persist(
      exists
        ? apis.map((a) => (a.id === cleaned.id ? cleaned : a))
        : [...apis, cleaned],
    );
    setDraft(null);
  }

  function edit(a: SavedApi) {
    // Don't surface the stored key; empty field = keep existing.
    setDraft({ ...a, api_key: "" });
  }

  return (
    <div className="api-registry" data-testid="api-registry">
      <p className="settings-hint">
        Register an API once; the agent calls it by name via{" "}
        <code>call_api</code>. Your key is stored in the macOS Keychain and
        injected server-side — the model never sees it.
      </p>
      {err && (
        <div className="settings-tuning-row" style={{ color: "var(--danger)" }}>
          {err}
        </div>
      )}

      <div className="api-list">
        {apis.length === 0 && (
          <div className="settings-hint">No APIs registered yet.</div>
        )}
        {apis.map((a) => (
          <div key={a.id} className="api-row" data-testid="api-row">
            <div className="api-row-main">
              <span className="api-row-name">{a.name}</span>
              <span className="api-row-url">{a.base_url}</span>
            </div>
            <button type="button" className="api-link" onClick={() => edit(a)}>
              Edit
            </button>
            <button
              type="button"
              className="api-del"
              aria-label={`Remove ${a.name}`}
              onClick={() => void persist(apis.filter((x) => x.id !== a.id))}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>

      {draft ? (
        <div className="api-form" data-testid="api-form">
          <label className="api-field">
            Name
            <input
              value={draft.name}
              placeholder="GitHub"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label className="api-field">
            Base URL
            <input
              value={draft.base_url}
              placeholder="https://api.github.com"
              onChange={(e) => setDraft({ ...draft, base_url: e.target.value })}
            />
          </label>
          <label className="api-field">
            Auth header
            <input
              value={draft.auth_header ?? "Authorization"}
              onChange={(e) =>
                setDraft({ ...draft, auth_header: e.target.value })
              }
            />
          </label>
          <label className="api-field">
            Auth template
            <input
              value={draft.auth_template ?? "Bearer {key}"}
              placeholder="Bearer {key}"
              onChange={(e) =>
                setDraft({ ...draft, auth_template: e.target.value })
              }
            />
          </label>
          <label className="api-field">
            Key{" "}
            {apis.some((a) => a.id === draft.id) && (
              <span className="settings-hint">(blank = keep current)</span>
            )}
            <input
              type="password"
              value={draft.api_key ?? ""}
              placeholder="paste secret key"
              onChange={(e) => setDraft({ ...draft, api_key: e.target.value })}
            />
          </label>
          <div className="api-form-actions">
            <button type="button" onClick={save}>
              Save
            </button>
            <button type="button" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="api-add"
          onClick={() => setDraft(blankDraft())}
        >
          + Add API
        </button>
      )}
    </div>
  );
}
