import { useCallback, useEffect, useState } from "react";
import { abbrev, relTimeEpoch as relTime } from "../../lib/format";
import { api } from "../../lib/tauri-api";
import type { CustomBackend } from "../../types";
import { Button, Input, Spinner, Badge } from "../ui";
import { Download, Heart, Check } from "lucide-react";

const MS_INFERENCE_BASE = "https://api-inference.modelscope.cn/v1";

interface MsModel {
  repo: string; // org/name
  name: string;
  org: string;
  downloads: number;
  stars: number;
  last_updated: number; // epoch seconds (0 if unknown)
  task: string | null;
  support_api_inference: boolean;
  avatar: string | null; // org logo URL
  cover: string | null; // optional banner URL
}

/** Org avatar with graceful fallback to the initial-letter chip on load error. */
function MsAvatar({ src, initial }: { src: string | null; initial: string }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    return <div className="hfl-avatar" aria-hidden>{initial}</div>;
  }
  return (
    <img className="hfl-avatar-img" src={src} alt="" loading="lazy" onError={() => setBroken(true)} />
  );
}


/**
 * ModelScope source for the Model Browser. Browses ModelScope's text-gen
 * catalog (the `dolphin` search API) as cards matching the HF layout, and —
 * for models flagged `SupportApiInference` — registers ModelScope's
 * OpenAI-compatible inference endpoint as a custom backend so the model is
 * usable in chat. Requires a ModelScope API token (from
 * modelscope.cn → Access Tokens), kept in session only (the Rust side stores
 * it in the Keychain once a backend is registered).
 */
export function ModelScopeBrowserTab({
  query,
  onConnected,
}: {
  query: string;
  onConnected?: () => void;
}) {
  const [models, setModels] = useState<MsModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [connected, setConnected] = useState<string | null>(null);

  // Proxied through Rust (ModelScope's API sends no CORS headers).
  const load = useCallback(async (q: string) => {
    setLoading(true);
    setErr(null);
    try {
      setModels(await api.modelscopeSearch(q));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "couldn't reach ModelScope");
      setModels([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Reload when the shared Model Browser query changes (debounced by the parent).
  useEffect(() => {
    void load(query);
  }, [load, query]);

  const connect = useCallback(
    async (m: MsModel) => {
      const repo = m.repo;
      if (!token.trim()) {
        setErr("Enter your ModelScope API token first (modelscope.cn → Access Tokens).");
        return;
      }
      setBusy(repo);
      setErr(null);
      try {
        const settings = await api.settingsGet();
        const existing: CustomBackend[] = settings.custom_backends ?? [];
        const cb: CustomBackend = {
          id: `modelscope-${repo}`,
          name: `ModelScope · ${m.name}`,
          base_url: MS_INFERENCE_BASE,
          model: repo,
          api_key: token.trim(),
        };
        await api.settingsSet({
          custom_backends: [...existing.filter((b) => b.id !== cb.id), cb],
        });
        setConnected(repo);
        onConnected?.();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [token, onConnected],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }} data-testid="modelscope-tab">
      {/* Token row */}
      <div style={{ display: "flex", gap: "var(--space-2)", padding: "var(--space-3)", borderBottom: "1px solid var(--border-subtle)", alignItems: "center" }}>
        <Input
          type="password"
          placeholder="ModelScope API token (modelscope.cn → Access Tokens)"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          data-testid="modelscope-token"
        />
        <span style={{ fontSize: "var(--fs-2xs)", color: "var(--text-3)", whiteSpace: "nowrap" }}>
          stored in Keychain on connect
        </span>
      </div>

      {err && (
        <div style={{ padding: "var(--space-2) var(--space-3)", color: "var(--warn-fg)", fontSize: "var(--fs-xs)" }}>
          {err}
        </div>
      )}

      {loading && models.length === 0 ? (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", color: "var(--text-2)", padding: "var(--space-5)" }}>
          <Spinner /> Loading ModelScope catalog…
        </div>
      ) : (
        <div className="hfl-grid" data-testid="modelscope-grid">
          {models.map((m) => {
            const repo = m.repo;
            const initial = (m.org?.[0] ?? m.name[0] ?? "?").toUpperCase();
            const task = m.task;
            const updated = relTime(m.last_updated);
            const isConnected = connected === repo;
            return (
              <div className="hfl-card" key={repo}>
                {m.cover && (
                  <img className="hfl-cover" src={m.cover} alt="" loading="lazy" />
                )}
                <div className="hfl-card-head">
                  <MsAvatar src={m.avatar} initial={initial} />
                  <div className="hfl-card-id" title={repo}>{repo}</div>
                </div>
                <div className="hfl-card-chips">
                  {task && <span className="hfl-pipeline">{task.replace(/-/g, " ")}</span>}
                  {m.support_api_inference && <span className="hfl-lib-pill">API</span>}
                </div>
                <div className="hfl-card-foot">
                  <span className="hfl-updated">{updated ? `Updated ${updated}` : "—"}</span>
                  <span className="hfl-stats">
                    <span title="Downloads"><Download size={12} /> {abbrev(m.downloads)}</span>
                    <span title="Stars" style={{ marginLeft: 8 }}><Heart size={12} /> {abbrev(m.stars)}</span>
                  </span>
                </div>
                <div className="hfl-card-actions">
                  {isConnected ? (
                    <Button size="sm" variant="secondary" disabled>
                      In chat <Check size={14} />
                    </Button>
                  ) : m.support_api_inference ? (
                    <Button size="sm" variant="primary" onClick={() => void connect(m)} disabled={busy !== null} aria-busy={busy === repo}>
                      {busy === repo ? <Spinner label="Connecting" /> : "Use in chat"}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void api.openExternal(`https://modelscope.cn/models/${repo}`)}
                    >
                      Open ↗
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
          {!loading && models.length === 0 && (
            <div style={{ color: "var(--text-3)", padding: "var(--space-4)" }}>
              No models found.
            </div>
          )}
        </div>
      )}

      {connected && (
        <div style={{ padding: "var(--space-2) var(--space-3)", borderTop: "1px solid var(--border-subtle)", fontSize: "var(--fs-xs)", color: "var(--text-2)" }} role="status">
          <Badge tone="success">connected</Badge> {connected} — pick it in the chat model picker.
        </div>
      )}
    </div>
  );
}
