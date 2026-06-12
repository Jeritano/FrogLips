import { useCallback, useEffect, useRef, useState } from "react";
import { abbrev, paramPill, relTime } from "../lib/format";
import { api } from "../lib/tauri-api";
import { useTauriEvent } from "../hooks/useTauriEvent";
import type { CustomBackend, LlmpmServeStatus } from "../types";
import { Button, Input, Spinner } from "./ui";
import { Download, Heart } from "lucide-react";
import { PIPELINE_COLOR } from "./hf-library/constants";
import { extractParams, type HfModel } from "./hf-library/loader";

const LLMPM_BACKEND_ID = "llmpm-local";

/** One catalog card — matches the HF library's `.hfl-card` layout (avatar,
 *  id, pipeline + param + library chips, updated/downloads/likes), with an
 *  llmpm Install/Serve action. */
function LlmpmCard({
  m,
  installed,
  serving,
  busy,
  anyBusy,
  onInstall,
  onServe,
}: {
  m: HfModel;
  installed: boolean;
  serving: boolean;
  /** This card's own op is in flight (show spinner). */
  busy: boolean;
  /** ANY install/serve is in flight (disable this card's action too). */
  anyBusy: boolean;
  onInstall: () => void;
  onServe: () => void;
}) {
  const initial = (m.id.split("/")[0]?.[0] ?? m.id[0] ?? "?").toUpperCase();
  const pipeline = m.pipeline_tag ?? null;
  const pColor = pipeline ? (PIPELINE_COLOR[pipeline] ?? "#6b7280") : null;
  const params = paramPill(extractParams(m));
  const updated = relTime(m.lastModified);
  return (
    <div className="hfl-card">
      <div className="hfl-card-head">
        <div className="hfl-avatar" aria-hidden>
          {initial}
        </div>
        <div className="hfl-card-id" title={m.id}>
          {m.id}
        </div>
      </div>
      <div className="hfl-card-chips">
        {pipeline && (
          <span
            className="hfl-pipeline"
            style={{
              borderColor: pColor ?? undefined,
              color: pColor ?? undefined,
            }}
          >
            {pipeline.replace(/-/g, " ")}
          </span>
        )}
        {params && <span className="hfl-param-pill">{params}</span>}
        {m.library_name && (
          <span className="hfl-lib-pill">{m.library_name}</span>
        )}
      </div>
      <div className="hfl-card-foot">
        <span className="hfl-updated">
          {updated ? `Updated ${updated}` : "—"}
        </span>
        <span className="hfl-stats">
          <span title="Downloads">
            <Download size={12} /> {abbrev(m.downloads)}
          </span>
          <span title="Likes" style={{ marginLeft: 8 }}>
            <Heart size={12} /> {abbrev(m.likes)}
          </span>
        </span>
      </div>
      <div className="hfl-card-actions">
        {serving ? (
          <Button size="sm" variant="secondary" disabled>
            Serving
          </Button>
        ) : installed ? (
          <Button
            size="sm"
            variant="primary"
            onClick={onServe}
            disabled={anyBusy}
            aria-busy={busy}
          >
            {busy ? <Spinner label="Serving" /> : "Serve"}
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={onInstall}
            disabled={anyBusy}
            aria-busy={busy}
          >
            {busy ? <Spinner label="Installing" /> : "Install"}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * llmpm source for the Model Browser. Browse the HuggingFace GGUF catalog as
 * cards (matching the HF library layout), install via llmpm, then serve —
 * Froglips spawns `llmpm serve`, waits for the OpenAI endpoint, and
 * auto-registers it as a custom backend so it appears in the chat picker.
 */
export function LlmpmPanel({
  onBackendsChanged,
}: {
  onBackendsChanged?: () => void;
}) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [installed, setInstalled] = useState<
    { repo: string; backend: string }[]
  >([]);
  const [serveStatus, setServeStatus] = useState<LlmpmServeStatus | null>(null);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<HfModel[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);

  const [busyRepo, setBusyRepo] = useState<string | null>(null);
  const [progress, setProgress] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const refreshInstalled = useCallback(async () => {
    try {
      setInstalled(await api.llmpmInstalledModels());
    } catch {
      /* keep */
    }
  }, []);
  const refreshServe = useCallback(async () => {
    try {
      setServeStatus(await api.llmpmServeStatus());
    } catch {
      /* keep */
    }
  }, []);

  useEffect(() => {
    api
      .llmpmAvailable()
      .then((a) => setAvailable(a.available))
      .catch(() => setAvailable(false));
    void refreshInstalled();
    void refreshServe();
  }, [refreshInstalled, refreshServe]);

  // While serving, poll status so a crashed/out-of-band-stopped server clears
  // the stale "Serving" banner instead of hanging until remount.
  useEffect(() => {
    if (!serveStatus?.serving) return;
    const t = setInterval(() => void refreshServe(), 8000);
    return () => clearInterval(t);
  }, [serveStatus?.serving, refreshServe]);

  useTauriEvent<{ repo: string; line: string }>(
    "llmpm-install-progress",
    (e) => {
      if (e.payload?.line) setProgress(e.payload.line);
    },
    [],
  );

  // Browse the HF GGUF catalog (rich fields via full=true). Empty query →
  // most-downloaded; query → filtered.
  const loadBrowse = useCallback(async (q: string) => {
    setSearching(true);
    setSearchErr(null);
    try {
      const params = new URLSearchParams({
        limit: "60",
        sort: "downloads",
        direction: "-1",
        filter: "gguf",
        full: "true",
      });
      if (q.trim()) params.set("search", q.trim());
      const res = await fetch(`https://huggingface.co/api/models?${params}`);
      if (!res.ok) throw new Error(`HF ${res.status}`);
      const data: HfModel[] = await res.json();
      setHits(data);
    } catch (err) {
      setSearchErr(
        err instanceof Error ? err.message : "couldn't reach HuggingFace",
      );
      setHits([]);
    } finally {
      setSearching(false);
    }
  }, []);

  const search = useCallback(() => void loadBrowse(query), [loadBrowse, query]);
  useEffect(() => {
    void loadBrowse("");
  }, [loadBrowse]);

  const install = useCallback(
    async (repo: string) => {
      setBusyRepo(repo);
      setError(null);
      setProgress("Starting install…");
      try {
        await api.llmpmInstall(repo, "Q4_K_M");
        await refreshInstalled();
        setProgress("");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyRepo(null);
      }
    },
    [refreshInstalled],
  );

  const serve = useCallback(
    async (repo: string) => {
      setBusyRepo(repo);
      setError(null);
      setProgress("Starting server (model load can take ~30–60s)…");
      try {
        const status = await api.llmpmServe(repo);
        setServeStatus(status);
        if (status.base_url) {
          const settings = await api.settingsGet();
          const existing: CustomBackend[] = settings.custom_backends ?? [];
          const cb: CustomBackend = {
            id: LLMPM_BACKEND_ID,
            name: `llmpm · ${repo.split("/").pop() ?? repo}`,
            base_url: status.base_url,
            model: repo,
            api_key: null,
          };
          await api.settingsSet({
            custom_backends: [
              ...existing.filter((b) => b.id !== LLMPM_BACKEND_ID),
              cb,
            ],
          });
          onBackendsChanged?.();
        }
        setProgress("");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyRepo(null);
      }
    },
    [onBackendsChanged],
  );

  const stop = useCallback(async () => {
    setError(null);
    try {
      await api.llmpmStop();
      const settings = await api.settingsGet();
      const existing: CustomBackend[] = settings.custom_backends ?? [];
      const next = existing.filter((b) => b.id !== LLMPM_BACKEND_ID);
      if (next.length !== existing.length) {
        await api.settingsSet({ custom_backends: next });
        onBackendsChanged?.();
      }
      await refreshServe();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [onBackendsChanged, refreshServe]);

  const installedRef = useRef(installed);
  installedRef.current = installed;
  const isInstalled = (repo: string) =>
    installedRef.current.some((m) => m.repo === repo);

  if (available === false) {
    return (
      <div
        className="llmpm-panel"
        data-testid="llmpm-panel"
        style={{ padding: "var(--space-4)" }}
      >
        <p style={{ color: "var(--text-2)" }}>
          <strong>llmpm not found.</strong> Install it, then reopen:
        </p>
        <pre className="ui-input" style={{ padding: "var(--space-3)" }}>
          pip install llmpm # or: npm install -g llmpm
        </pre>
        <p style={{ color: "var(--text-3)", fontSize: "var(--fs-xs)" }}>
          Installed but not detected? Set the <code>LLMPM_BIN</code> env var to
          its path.
        </p>
      </div>
    );
  }

  return (
    <div
      className="llmpm-panel"
      data-testid="llmpm-panel"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          gap: "var(--space-2)",
          padding: "var(--space-3)",
          borderBottom: "1px solid var(--border-subtle)",
          alignItems: "center",
        }}
      >
        <Input
          placeholder="Search HuggingFace GGUF models (or paste org/model)…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          data-testid="llmpm-search-input"
        />
        <Button onClick={search} disabled={searching}>
          {searching ? <Spinner /> : "Search"}
        </Button>
        {query.includes("/") && !isInstalled(query.trim()) && (
          <Button
            variant="secondary"
            onClick={() => void install(query.trim())}
            disabled={busyRepo !== null}
          >
            Install pasted
          </Button>
        )}
      </div>

      {/* Serving banner */}
      {serveStatus?.serving && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            padding: "var(--space-2) var(--space-3)",
            background: "var(--green-bg)",
            borderBottom: "1px solid var(--green-border)",
            fontSize: "var(--fs-sm)",
          }}
          data-testid="llmpm-serving"
          role="status"
          aria-live="polite"
        >
          <span
            style={{
              color: "var(--green-fg)",
              fontWeight: "var(--fw-semibold)",
            }}
          >
            ● Serving
          </span>
          <span style={{ color: "var(--text)" }}>{serveStatus.repo}</span>
          <span style={{ color: "var(--text-3)" }}>{serveStatus.base_url}</span>
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="danger" onClick={() => void stop()}>
            Stop
          </Button>
        </div>
      )}

      {searchErr && (
        <div
          style={{
            padding: "var(--space-2) var(--space-3)",
            color: "var(--warn-fg)",
            fontSize: "var(--fs-xs)",
          }}
        >
          {searchErr} — paste an exact <code>org/model</code> above to install
          directly.
        </div>
      )}

      {/* Card grid — reuses the HF library's .hfl-grid / .hfl-card styling. */}
      {searching && hits.length === 0 ? (
        <div
          className="skeleton-list"
          aria-busy="true"
          aria-label="Loading catalog"
        >
          <div className="skeleton-row" />
          <div className="skeleton-row" />
          <div className="skeleton-row" />
          <div className="skeleton-row" />
          <div className="skeleton-row" />
        </div>
      ) : (
        <div className="hfl-grid" data-testid="llmpm-grid">
          {hits.map((m) => (
            <LlmpmCard
              key={m.id}
              m={m}
              installed={isInstalled(m.id)}
              serving={serveStatus?.repo === m.id}
              busy={busyRepo === m.id}
              anyBusy={busyRepo !== null}
              onInstall={() => void install(m.id)}
              onServe={() => void serve(m.id)}
            />
          ))}
        </div>
      )}

      {(progress || error) && (
        <div
          style={{
            padding: "var(--space-2) var(--space-3)",
            borderTop: "1px solid var(--border-subtle)",
          }}
        >
          {progress && (
            <div
              style={{
                fontSize: "var(--fs-xs)",
                color: "var(--text-2)",
                fontFamily: "var(--mono)",
              }}
              data-testid="llmpm-progress"
            >
              {progress}
            </div>
          )}
          {error && (
            <div
              className="image-error-row"
              role="alert"
              data-testid="llmpm-error"
            >
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
