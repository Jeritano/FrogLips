import { useRef, useState } from "react";
import { X } from "lucide-react";
import { useModalA11y } from "../lib/use-modal-a11y";
import { CustomBackendsSettings } from "./CustomBackendsSettings";
import { RoutesSettings } from "./RoutesSettings";
import { checkForUpdate } from "../lib/updater";
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
                <div className="settings-row settings-version">
                  Froglips v{pkg.version}
                </div>
              </div>
            )}
            {pane === "backends" && (
              <CustomBackendsSettings onChanged={onBackendsChanged} />
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
