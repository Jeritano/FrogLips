import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useModalA11y } from "../lib/use-modal-a11y";
import { CustomBackendsSettings } from "./CustomBackendsSettings";
import { RoutesSettings } from "./RoutesSettings";
import { ApiRegistrySettings } from "./ApiRegistrySettings";
import { checkForUpdate } from "../lib/updater";
import { api } from "../lib/tauri-api";
import {
  useSettingsGetter,
  useUpdateSettings,
} from "../contexts/SettingsContext";
import pkg from "../../package.json";
import type { ThemePref } from "../lib/appearance";
import type { ModelEntry, ServerStatus } from "../types";

/*
 * App settings window (Cmd+, — product review 2026-06-10, IA #2). App-level
 * configuration used to be gated behind the per-conversation agent toggle:
 * adding a cloud backend required being on the chat view, with an agent-
 * capable backend running, with the agent gear open. This modal hosts the
 * app-scoped panes; agent-RUN settings (workspace, allowlist, dry-run,
 * approve-alls) intentionally stay in the agent toolbar because they are
 * per-conversation context, not app config.
 */

type Pane = "general" | "backends" | "routes" | "apis";

interface Props {
  open: boolean;
  onClose: () => void;
  status: ServerStatus | null;
  /** User's theme preference (light | dark | system), owned by App. */
  themePref: ThemePref;
  /** Set an explicit theme preference (System follows the OS, live). */
  onSetThemePref: (pref: ThemePref) => void;
  onRerunWizard: () => void;
  /** Fires after backend config changes so hosts can refresh pickers. */
  onBackendsChanged?: () => void;
}

/**
 * Inference perf O3/O6/M1 (2026-06-11): the daemon-level Ollama knobs (flash
 * attention, KV-cache quantization) are ENV VARS on the daemon process — the
 * app can only set them when it spawns the daemon itself (it does, when the
 * port is closed at Start). For user-managed daemons this card surfaces the
 * copy-paste commands, the running daemon version (0.19+ = MLX engine,
 * roughly 2x decode on Apple Silicon), and the Metal wired-limit headroom.
 */
function OllamaTuningCard() {
  const [version, setVersion] = useState<string | null>(null);
  const [wiredMb, setWiredMb] = useState<number | null>(null);
  const [ramGb, setRamGb] = useState<number | null>(null);
  useEffect(() => {
    void fetch("http://127.0.0.1:11434/api/version")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { version?: string } | null) => setVersion(j?.version ?? null))
      .catch(() => setVersion(null));
    void api
      .systemInfo()
      .then((i) => {
        setWiredMb(i.wired_limit_mb ?? 0);
        setRamGb(i.total_ram_gb);
      })
      .catch(() => {});
  }, []);
  const bigRam = (ramGb ?? 0) >= 96;
  const wiredDefault = wiredMb === 0;
  return (
    <div className="settings-tuning-card" data-testid="ollama-tuning-card">
      <div className="settings-tuning-title">Ollama daemon tuning</div>
      <div className="settings-tuning-row">
        Daemon: {version ? `v${version} running` : "not reachable"}
        {version && " — for the fastest Apple-Silicon engine keep it ≥ 0.19"}
      </div>
      <div className="settings-tuning-row">
        These are daemon environment variables — when Froglips starts the daemon
        itself they're applied automatically; for a daemon you manage (menubar
        app / brew services), run once and restart it:
      </div>
      <pre className="settings-tuning-code">
        {`launchctl setenv OLLAMA_FLASH_ATTENTION 1
launchctl setenv OLLAMA_KV_CACHE_TYPE q8_0`}
      </pre>
      <div className="settings-tuning-row settings-hint">
        Flash attention: +5-20% tok/s at long context. KV q8_0: halves KV-cache
        RAM (gigabytes back per loaded model) with negligible quality loss.
      </div>
      {bigRam && wiredDefault && (
        <div className="settings-tuning-row settings-hint">
          Metal wired limit is at the macOS default (~75% of RAM). For 90GB+
          models on this machine, raising it avoids eviction stalls:
          <code> sudo sysctl iogpu.wired_limit_mb=118784</code>
        </div>
      )}
    </div>
  );
}

/**
 * MLX backend tuning (W2-MODELS items 2 + 3). Surfaces two knobs that were
 * fully wired in the Rust spawn path but had no UI:
 *   - Draft model (`--draft-model`): speculative decoding — pair a small model
 *     of the SAME tokenizer family beside a big one for ~1.5-2.5x decode with
 *     an unchanged output distribution.
 *   - Max response tokens (`--max-tokens`): mlx_lm.server has NO context-window
 *     flag (context is fixed by the model config), and its built-in 512-token
 *     default truncates long replies — this raises that default.
 * Both apply on the NEXT MLX model start; a running server keeps its flags.
 */
function MlxTuningCard() {
  const [mlxModels, setMlxModels] = useState<ModelEntry[]>([]);
  const [draftInit, setDraftInit] = useState("");
  const [maxTokInit, setMaxTokInit] = useState("");
  const getSettings = useSettingsGetter();
  const updateSettings = useUpdateSettings();
  useEffect(() => {
    void api
      .listAllModels()
      .then((m) => setMlxModels(m.mlx))
      .catch(() => {});
    void getSettings()
      .then((s) => {
        setDraftInit(s.mlx_draft_model ?? "");
        setMaxTokInit(s.mlx_max_tokens != null ? String(s.mlx_max_tokens) : "");
      })
      .catch(() => {});
  }, [getSettings]);
  return (
    <div className="settings-tuning-card" data-testid="mlx-tuning-card">
      <div className="settings-tuning-title">MLX backend tuning</div>
      <div className="settings-tuning-row">
        <span>Draft model</span>
        <select
          // Keyed on the loaded value so the persisted selection becomes the
          // default once the async settings + model-list reads resolve (a bare
          // defaultValue is captured on first render, before either lands).
          key={`draft-${draftInit}`}
          data-testid="settings-mlx-draft-model"
          defaultValue={draftInit}
          onChange={(e) => {
            void updateSettings({
              mlx_draft_model: e.target.value || null,
            }).catch(() => {});
          }}
        >
          <option value="">None (no speculative decoding)</option>
          {mlxModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
            </option>
          ))}
        </select>
      </div>
      <div className="settings-tuning-row settings-hint">
        Speculative decoding: a SMALL model of the same tokenizer family (e.g. a
        0.6B beside a 32B) drafts tokens the main model verifies — ~1.5-2.5x
        decode, identical output. Mismatched families just run slower.
      </div>
      <div className="settings-tuning-row">
        <span>Max response tokens</span>
        <input
          // Keyed like the draft select so a persisted value applies once the
          // async settings read resolves (defaultValue is mount-only).
          key={`maxtok-${maxTokInit}`}
          data-testid="settings-mlx-max-tokens"
          type="number"
          min={1}
          max={131072}
          placeholder="512 (server default)"
          defaultValue={maxTokInit}
          style={{ width: 120 }}
          onChange={(e) => {
            const raw = e.target.value.trim();
            if (raw === "") {
              void updateSettings({ mlx_max_tokens: null }).catch(() => {});
              return;
            }
            const n = Math.min(
              131072,
              Math.max(1, Math.floor(Number(raw) || 512)),
            );
            void updateSettings({ mlx_max_tokens: n }).catch(() => {});
          }}
        />
      </div>
      <div className="settings-tuning-row settings-hint">
        mlx_lm.server has no context-window setting (the window is fixed by the
        model). This raises its default reply length — the built-in 512 cuts
        long answers short. Applies on the next MLX model start.
      </div>
    </div>
  );
}

const PANES: { id: Pane; label: string }[] = [
  { id: "general", label: "General" },
  { id: "backends", label: "Backends" },
  { id: "routes", label: "Routes" },
  { id: "apis", label: "APIs" },
];

export function SettingsModal({
  open,
  onClose,
  status,
  themePref,
  onSetThemePref,
  onRerunWizard,
  onBackendsChanged,
}: Props) {
  const [pane, setPane] = useState<Pane>("general");
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [keepAliveInit, setKeepAliveInit] = useState("30m");
  const [maxIterInit, setMaxIterInit] = useState("80");
  // Auto-update is ON BY DEFAULT — only an explicit `false` opts out, so absent/
  // null reads as checked. See useUpdateCheck for the matching gate semantics.
  const [autoUpdate, setAutoUpdate] = useState(true);
  // Backend admission controls (item 5). Permits default to 1 (serialize local
  // inference); liveness probe defaults ON (only an explicit `false` opts out,
  // matching the Rust `Option<bool>` semantics).
  const [permitsInit, setPermitsInit] = useState("1");
  const [livenessProbe, setLivenessProbe] = useState(true);
  const getSettings = useSettingsGetter();
  const updateSettings = useUpdateSettings();
  useEffect(() => {
    void getSettings()
      .then((s) => {
        setKeepAliveInit(s.ollama_keep_alive ?? "30m");
        setMaxIterInit(String(s.agent_max_iterations ?? 80));
        setAutoUpdate(s.auto_update_check !== false);
        setPermitsInit(String(s.inference_permits ?? 1));
        setLivenessProbe(s.backend_liveness_probe !== false);
      })
      .catch(() => {});
  }, [getSettings]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  useModalA11y({ open, onClose, containerRef });

  if (!open) return null;

  async function checkUpdates() {
    setUpdateMsg("Checking…");
    try {
      const upd = await checkForUpdate();
      if (!upd) {
        setUpdateMsg("Up to date.");
        return;
      }
      setUpdateMsg(`Update available: v${upd.version}. Downloading…`);
      // install() downloads, installs, and relaunches (see lib/updater.ts).
      await upd.install();
      setUpdateMsg("Installed. Relaunching…");
    } catch (e) {
      setUpdateMsg(`Update failed: ${e}`);
    }
  }

  return (
    <div
      className="memories-overlay"
      data-testid="settings-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="memories-modal settings-modal"
        role="dialog"
        aria-label="Settings"
        ref={containerRef}
      >
        <div className="settings-head">
          <span className="settings-title">Settings</span>
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="memories-close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="settings-body">
          <div
            className="settings-rail"
            role="tablist"
            aria-label="Settings sections"
          >
            {PANES.map((p) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={pane === p.id}
                className={`settings-rail-btn${pane === p.id ? " active" : ""}`}
                data-testid={`settings-pane-${p.id}`}
                onClick={() => setPane(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="settings-pane">
            {pane === "general" && (
              <div className="settings-general">
                <div className="settings-row">
                  <span>Theme</span>
                  <select
                    data-testid="settings-theme-pref"
                    value={themePref}
                    aria-label="App theme"
                    onChange={(e) =>
                      onSetThemePref(e.target.value as ThemePref)
                    }
                  >
                    <option value="system">System (follow OS)</option>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                </div>
                <div className="settings-row">
                  <span>Updates</span>
                  <button type="button" onClick={() => void checkUpdates()}>
                    Check for updates
                  </button>
                  {updateMsg && (
                    <span className="settings-hint">{updateMsg}</span>
                  )}
                </div>
                <div className="settings-row">
                  <span>Auto-update</span>
                  <label>
                    <input
                      data-testid="settings-auto-update"
                      type="checkbox"
                      checked={autoUpdate}
                      onChange={(e) => {
                        const next = e.target.checked;
                        setAutoUpdate(next);
                        void updateSettings({
                          auto_update_check: next,
                        }).catch(() => {
                          // Persist failed — revert the optimistic toggle so the
                          // UI reflects the real (unchanged) setting.
                          setAutoUpdate(!next);
                        });
                      }}
                    />{" "}
                    Check for updates automatically in the background
                  </label>
                </div>
                <div className="settings-row">
                  <span>Setup</span>
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onRerunWizard();
                    }}
                  >
                    Re-run setup wizard
                  </button>
                </div>
                <div className="settings-row">
                  <span>Model idle</span>
                  <select
                    data-testid="settings-keep-alive"
                    defaultValue={keepAliveInit}
                    onChange={(e) => {
                      void updateSettings({
                        ollama_keep_alive: e.target.value,
                      }).catch(() => {});
                    }}
                  >
                    <option value="5m">Unload after 5 min idle</option>
                    <option value="30m">Unload after 30 min idle</option>
                    <option value="-1">Keep loaded forever</option>
                  </select>
                  <span className="settings-hint">
                    Longer = no reload wait after a break (Ollama models).
                  </span>
                </div>
                <div className="settings-row">
                  <span>Agent turn limit</span>
                  <input
                    data-testid="settings-agent-max-iter"
                    type="number"
                    min={5}
                    max={400}
                    defaultValue={maxIterInit}
                    style={{ width: 80 }}
                    onChange={(e) => {
                      const n = Math.min(
                        400,
                        Math.max(5, Math.floor(Number(e.target.value) || 80)),
                      );
                      void updateSettings({ agent_max_iterations: n }).catch(
                        () => {},
                      );
                    }}
                  />
                  <span className="settings-hint">
                    Max tool-turns per agent run (default 80). Raise for long
                    multi-file builds; lower to cap runaway loops.
                  </span>
                </div>
                <div className="settings-row settings-version">
                  Froglips v{pkg.version}
                </div>
              </div>
            )}
            {pane === "backends" && (
              <>
                <div
                  className="settings-tuning-card"
                  data-testid="inference-admission-card"
                >
                  <div className="settings-tuning-title">
                    Inference admission
                  </div>
                  <div className="settings-tuning-row">
                    <span>Concurrent local inference</span>
                    <input
                      // Keyed on the loaded value so the persisted count becomes
                      // the default once the async settings read resolves.
                      key={`permits-${permitsInit}`}
                      data-testid="settings-inference-permits"
                      type="number"
                      min={1}
                      max={8}
                      defaultValue={permitsInit}
                      style={{ width: 80 }}
                      onChange={(e) => {
                        const n = Math.min(
                          8,
                          Math.max(1, Math.floor(Number(e.target.value) || 1)),
                        );
                        void updateSettings({ inference_permits: n }).catch(
                          () => {},
                        );
                      }}
                    />
                  </div>
                  <div className="settings-tuning-row settings-hint">
                    How many local inference calls may run at once. 1 (default)
                    serializes them so a flow / subagent fan-out doesn&apos;t
                    thrash one GPU. Raise only if your hardware comfortably runs
                    several models in parallel. Cloud routes always bypass this.
                  </div>
                  <div className="settings-tuning-row">
                    <span>Backend liveness probe</span>
                    <label>
                      <input
                        data-testid="settings-liveness-probe"
                        type="checkbox"
                        checked={livenessProbe}
                        onChange={(e) => {
                          const next = e.target.checked;
                          setLivenessProbe(next);
                          void updateSettings({
                            backend_liveness_probe: next,
                          }).catch(() => {
                            // Persist failed — revert the optimistic toggle.
                            setLivenessProbe(!next);
                          });
                        }}
                      />{" "}
                      Periodically check a running backend still responds
                    </label>
                  </div>
                  <div className="settings-tuning-row settings-hint">
                    When on (default), the watcher pings a ready backend each
                    tick; a wedged MLX server is auto-restarted and a stuck
                    Ollama daemon is surfaced as degraded. Turn off only if the
                    probe is noisy on your setup.
                  </div>
                </div>
                <OllamaTuningCard />
                <MlxTuningCard />
                <CustomBackendsSettings onChanged={onBackendsChanged} />
              </>
            )}
            {pane === "routes" && (
              <RoutesSettings status={status} onClose={onClose} />
            )}
            {pane === "apis" && <ApiRegistrySettings />}
          </div>
        </div>
      </div>
    </div>
  );
}
