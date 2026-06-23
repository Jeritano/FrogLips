import { useEffect, useRef, useState } from "react";
import { ShieldCheck, Lock, Cloud, X } from "lucide-react";
import { useModalA11y } from "../lib/use-modal-a11y";
import { api } from "../lib/tauri-api";
import { AuditLog } from "./AuditLog";

/* ── Privacy & safety panel ─────────────────────────────────────────────────
 *
 * Makes the (extensive) local-first + agent-sandbox posture VISIBLE — a calm,
 * confident trust surface, not a nag. Shows whether the session is 100% local,
 * what the agent can touch (workspace), what is always blocked (credential /
 * system / SSRF gates), and the local-only agent activity log. Self-contained:
 * reads serverStatus + workspace on open; no prop threading.
 *
 * Copy mirrors the real gates documented in SECURITY.md. Read-only.
 */

const LOCAL_BACKENDS = new Set(["ollama", "mlx", "native"]);

export function PrivacyPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalA11y({ open, onClose, containerRef: ref });

  const [backend, setBackend] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<string | null>(null);

  // Anonymizing egress proxy (Tor/SOCKS). `proxy` is the editable input;
  // `proxyStatus` is the live reachability of whatever is currently saved.
  const [proxy, setProxy] = useState("");
  const [proxyStatus, setProxyStatus] = useState<{
    enabled: boolean;
    reachable: boolean | null;
  } | null>(null);
  const [proxyBusy, setProxyBusy] = useState(false);
  const [proxyMsg, setProxyMsg] = useState<string | null>(null);

  // Silent refresh for on-open / after-save (no message spam).
  const refreshProxyStatus = async () => {
    try {
      const st = await api.webProxyStatus();
      setProxyStatus({ enabled: st.enabled, reachable: st.reachable });
    } catch {
      setProxyStatus(null);
    }
  };

  // Test button: ALWAYS reports a result so the click is never silent —
  // reachable / not reachable / no proxy saved / error.
  async function testProxy() {
    setProxyBusy(true);
    setProxyMsg("Checking…");
    try {
      const st = await api.webProxyStatus();
      setProxyStatus({ enabled: st.enabled, reachable: st.reachable });
      if (!st.enabled) {
        setProxyMsg(
          proxy.trim()
            ? "No proxy saved yet — click Save first, then Test."
            : "No proxy configured — egress is direct (not anonymized).",
        );
      } else if (st.reachable === true) {
        setProxyMsg(
          `● Reachable — ${st.url} is answering. Outbound HTTP is routed through it.`,
        );
      } else {
        setProxyMsg(
          `● NOT reachable — ${st.url ?? "the proxy"} isn't answering on its port. Requests fail-closed (no direct fallback). Start Tor (SOCKS 9050) or fix the URL.`,
        );
      }
    } catch (e) {
      setProxyMsg(`Couldn't check proxy status: ${e}`);
    } finally {
      setProxyBusy(false);
    }
  }

  async function saveProxy() {
    setProxyBusy(true);
    setProxyMsg(null);
    try {
      await api.settingsSet({ web_proxy: proxy.trim() || null });
      await refreshProxyStatus();
      setProxyMsg(
        proxy.trim()
          ? "Saved. New connections route through the proxy; restart to be sure all do."
          : "Proxy disabled — egress is direct.",
      );
    } catch (e) {
      setProxyMsg(`Couldn't save: ${e}`);
    } finally {
      setProxyBusy(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const s = await api.serverStatus();
        setBackend(s.running ? s.backend : null);
      } catch {
        setBackend(null);
      }
      try {
        setWorkspace(await api.agentGetWorkspace());
      } catch {
        setWorkspace(null);
      }
      try {
        const s = await api.settingsGet();
        setProxy(s.web_proxy ?? "");
      } catch {
        setProxy("");
      }
      void refreshProxyStatus();
    })();
  }, [open]);

  // No running model, or a local backend → nothing leaves the machine.
  const isLocal = backend == null || LOCAL_BACKENDS.has(backend);

  return (
    <div
      className="dashboard-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Privacy and safety"
      data-testid="privacy-panel"
      ref={ref}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dashboard-modal privacy-modal">
        <div className="privacy-header">
          <h2 className="privacy-title">
            <ShieldCheck size={18} aria-hidden="true" /> Privacy &amp; safety
          </h2>
          <button
            className="dashboard-close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className={`privacy-trust ${isLocal ? "is-local" : "is-cloud"}`}>
          {isLocal ? (
            <>
              <Lock size={16} aria-hidden="true" />
              <span>
                <strong>100% local.</strong> Your prompts, files, memory, and
                chat history never leave this Mac. No accounts, no telemetry.
              </span>
            </>
          ) : (
            <>
              <Cloud size={16} aria-hidden="true" />
              <span>
                <strong>Cloud model active ({backend}).</strong> Only the
                messages you send to it leave your Mac — your files, memory, and
                history stay local.
              </span>
            </>
          )}
        </div>

        <section className="privacy-section">
          <h3>What the agent can touch</h3>
          <p className="privacy-scope">
            Workspace:{" "}
            <code>{workspace ?? "full filesystem (no workspace set)"}</code>
            {workspace
              ? " — file reads and writes are confined to this folder."
              : " — set a workspace to confine file access to one folder."}
          </p>
          <p className="privacy-muted">
            Every write, delete, shell command, and outbound network call is
            gated behind an explicit confirmation before it runs.
          </p>
        </section>

        <section className="privacy-section">
          <h3>Always blocked — even with your approval</h3>
          <ul className="privacy-list">
            <li>
              SSH / GPG / AWS keys, the macOS Keychain, and browser-saved
              credentials
            </li>
            <li>
              <code>.env</code> files, <code>credentials</code>, and Froglips'
              own secret store
            </li>
            <li>
              System dirs (<code>/etc</code>, <code>/System</code>), launch
              agents, and shell startup files
            </li>
            <li>
              Internal / loopback / cloud-metadata network addresses
              (SSRF-pinned)
            </li>
          </ul>
          <p className="privacy-muted">
            Path checks are case-insensitive, and untrusted text from the web,
            files, and tools is fenced as DATA so it can't hijack the agent.
          </p>
        </section>

        <section className="privacy-section">
          <h3>Anonymizing egress proxy</h3>
          <p className="privacy-muted">
            Route all outbound HTTP (web tools, cloud APIs, HuggingFace, the
            updater) through a proxy — typically Tor. Use{" "}
            <code>socks5h://127.0.0.1:9050</code> (the <code>h</code> resolves
            DNS at the proxy — no leak). Loopback is never proxied, so local
            Ollama/MLX keep working.
          </p>
          <div className="privacy-proxy-row">
            <input
              type="text"
              className="privacy-proxy-input"
              placeholder="socks5h://127.0.0.1:9050  (blank = direct)"
              value={proxy}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) => setProxy(e.target.value)}
              aria-label="Egress proxy URL"
            />
            <button
              type="button"
              className="privacy-proxy-save"
              onClick={() => void saveProxy()}
              disabled={proxyBusy}
            >
              {proxyBusy ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="privacy-proxy-save"
              onClick={() => void testProxy()}
              disabled={proxyBusy}
            >
              Test
            </button>
          </div>
          {proxyStatus?.enabled && (
            <p className="privacy-muted" data-testid="proxy-status">
              {proxyStatus.reachable === true
                ? "● Proxy reachable — egress is anonymized."
                : proxyStatus.reachable === false
                  ? "● Proxy NOT reachable — requests will FAIL (fail-closed, no direct fallback). Start Tor, or clear the field."
                  : "Proxy configured."}
            </p>
          )}
          {proxyMsg && <p className="privacy-muted">{proxyMsg}</p>}
          <p className="privacy-muted">
            Honest scope: this hides your IP for the HTTP paths. It does NOT make
            you untraceable — authenticated cloud APIs still log your account +
            content, and the computer-use browser can leak via fingerprinting.
            For real privacy, keep inference local.
          </p>
        </section>

        <section className="privacy-section">
          <h3>Agent activity</h3>
          <p className="privacy-muted">
            Every tool call the agent has made — stored locally, never sent
            anywhere.
          </p>
          <AuditLog />
        </section>
      </div>
    </div>
  );
}
