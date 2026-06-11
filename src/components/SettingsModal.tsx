import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useModalA11y } from "../lib/use-modal-a11y";
import { CustomBackendsSettings } from "./CustomBackendsSettings";
import { RoutesSettings } from "./RoutesSettings";
import { checkForUpdate } from "../lib/updater";
import { api } from "../lib/tauri-api";
import pkg from "../../package.json";
import type { ServerStatus } from "../types";

/*
 * App settings window (Cmd+, — product review 2026-06-10, IA #2). App-level
 * configuration used to be gated behind the per-conversation agent toggle:
 * adding a cloud backend required being on the chat view, with an agent-
 * capable backend running, with the agent gear open. This modal hosts the
 * app-scoped panes; agent-RUN settings (workspace, allowlist, dry-run,
 * approve-alls) intentionally stay in the agent toolbar because they are
 * per-conversation context, not app config.
 */

type Pane = "general" | "backends" | "routes";

interface Props {
  open: boolean;
  onClose: () => void;
  status: ServerStatus | null;
  theme: "dark" | "light";
  onToggleTheme: () => void;
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
        These are daemon environment variables — when Froglips starts the
        daemon itself they're applied automatically; for a daemon you manage
        (menubar app / brew services), run once and restart it:
      </div>
      <pre className="settings-tuning-code">
{`launchctl setenv OLLAMA_FLASH_ATTENTION 1
launchctl setenv OLLAMA_KV_CACHE_TYPE q8_0`}
      </pre>
      <div className="settings-tuning-row settings-hint">
        Flash attention: +5-20% tok/s at long context. KV q8_0: halves
        KV-cache RAM (gigabytes back per loaded model) with negligible
        quality loss.
      </div>
      {bigRam && wiredDefault && (
        <div className="settings-tuning-row settings-hint">
          Metal wired limit is at the macOS default (~75% of RAM). For
          90GB+ models on this machine, raising it avoids eviction stalls:
          <code> sudo sysctl iogpu.wired_limit_mb=118784</code>
        </div>
      )}
    </div>
  );
}

const PANES: { id: Pane; label: string }[] = [
  { id: "general", label: "General" },
  { id: "backends", label: "Backends" },
  { id: "routes", label: "Routes" },
];

export function SettingsModal({
  open,
  onClose,
  status,
  theme,
  onToggleTheme,
  onRerunWizard,
  onBackendsChanged,
}: Props) {
  const [pane, setPane] = useState<Pane>("general");
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [keepAliveInit, setKeepAliveInit] = useState("30m");
  useEffect(() => {
    void api
      .settingsGet()
      .then((s) => setKeepAliveInit(s.ollama_keep_alive ?? "30m"))
      .catch(() => {});
  }, []);
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
                  <button type="button" onClick={onToggleTheme}>
                    Switch to {theme === "dark" ? "light" : "dark"}
                  </button>
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
                      void api
                        .settingsSet({ ollama_keep_alive: e.target.value })
                        .catch(() => {});
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
                <div className="settings-row settings-version">
                  Froglips v{pkg.version}
                </div>
              </div>
            )}
            {pane === "backends" && (
              <>
                <OllamaTuningCard />
                <CustomBackendsSettings onChanged={onBackendsChanged} />
              </>
            )}
            {pane === "routes" && (
              <RoutesSettings status={status} onClose={onClose} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
