import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/tauri-api";
import { logDiag } from "../lib/diagnostics";
import type { McpServerConfig, McpServerInfo } from "../types";

/* ── MCP servers settings pane ────────────────────────────────────────── */
/*
 * Lets the user add/remove MCP servers, start/stop/restart them, and inspect
 * the tools each server exposes.
 *
 * Security: the `command` and `args` fields run with the app's full user
 * privileges. We surface a prominent warning so the user understands the
 * trust boundary. No autodiscovery from the network — only user-entered
 * configs are spawned.
 */

interface Props {
  /** Called whenever the user adds/removes/toggles a server so the parent can
   *  refresh persisted settings. */
  onConfigsChanged?: () => void;
}

function loadConfigs(): McpServerConfig[] {
  try {
    const raw = localStorage.getItem("mcp.servers");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s) =>
        s &&
        typeof s === "object" &&
        typeof s.name === "string" &&
        typeof s.command === "string",
    );
  } catch (err) {
    logDiag({
      level: "warn",
      source: "mcp",
      message: "loadConfigs: malformed localStorage 'mcp.servers' — defaulting to []",
      detail: err,
    });
    return [];
  }
}

function saveConfigs(list: McpServerConfig[]) {
  localStorage.setItem("mcp.servers", JSON.stringify(list));
  // Mirror to backend so auto-start works next launch. Failures here are
  // non-fatal — the user can still operate the servers in this session.
  api
    .settingsSet({ mcp_servers: list })
    .catch((e) => console.warn("[mcp] failed to persist servers", e));
}

export function McpSettings({ onConfigsChanged }: Props) {
  const [configs, setConfigs] = useState<McpServerConfig[]>(() => loadConfigs());
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [tools, setTools] = useState<Record<string, string[]>>({});
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftCommand, setDraftCommand] = useState("");
  const [draftArgs, setDraftArgs] = useState("");
  const [draftEnv, setDraftEnv] = useState("");

  const refresh = useCallback(async () => {
    try {
      const raw = await api.mcpListServers();
      const list = Array.isArray(raw) ? raw : [];
      setServers(list);
      const toolMap: Record<string, string[]> = {};
      for (const s of list) {
        try {
          const ts = await api.mcpListTools(s.name);
          toolMap[s.name] = Array.isArray(ts) ? ts.map((t) => t.name) : [];
        } catch (err) {
          logDiag({
            level: "info",
            source: "mcp",
            message: `mcpListTools '${s.name}' failed (server may be mid-restart)`,
            detail: err,
          });
        }
      }
      setTools(toolMap);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    // Light polling — keeps status fresh after start/stop without the
    // complexity of event-based push.
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  function persist(next: McpServerConfig[]) {
    setConfigs(next);
    saveConfigs(next);
    onConfigsChanged?.();
  }

  async function startConfig(cfg: McpServerConfig) {
    setErr(null);
    try {
      await api.mcpStartServer(cfg.name, cfg.command, cfg.args, cfg.env);
      refresh();
    } catch (e) {
      setErr(`Start '${cfg.name}': ${e}`);
    }
  }

  async function stopServer(name: string) {
    setErr(null);
    try {
      await api.mcpStopServer(name);
      refresh();
    } catch (e) {
      setErr(`Stop '${name}': ${e}`);
    }
  }

  async function restartConfig(cfg: McpServerConfig) {
    await stopServer(cfg.name).catch((err) =>
      logDiag({
        level: "warn",
        source: "mcp",
        message: `restartConfig: stop '${cfg.name}' threw before restart`,
        detail: err,
      }),
    );
    await startConfig(cfg);
  }

  async function removeConfig(name: string) {
    if (!confirm(`Remove MCP server '${name}'?`)) return;
    await stopServer(name).catch((err) =>
      logDiag({
        level: "warn",
        source: "mcp",
        message: `removeConfig: stop '${name}' threw before removal`,
        detail: err,
      }),
    );
    persist(configs.filter((c) => c.name !== name));
  }

  function addServer() {
    setErr(null);
    const name = draftName.trim();
    const command = draftCommand.trim();
    if (!name || !command) {
      setErr("Name and command are required.");
      return;
    }
    if (configs.some((c) => c.name === name)) {
      setErr(`A server named '${name}' already exists.`);
      return;
    }
    const args = draftArgs
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    let env: Record<string, string> = {};
    if (draftEnv.trim()) {
      try {
        const parsed = JSON.parse(draftEnv);
        if (parsed && typeof parsed === "object") {
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === "string") env[k] = v;
          }
        }
      } catch (e) {
        setErr(`env must be valid JSON: ${e}`);
        return;
      }
    }
    const cfg: McpServerConfig = { name, command, args, env, enabled: true };
    persist([...configs, cfg]);
    setDraftName("");
    setDraftCommand("");
    setDraftArgs("");
    setDraftEnv("");
    setAdding(false);
    startConfig(cfg);
  }

  async function showStderr(name: string) {
    try {
      const text = await api.mcpServerStderr(name);
      alert(text && text.trim() ? text : "(no stderr captured)");
    } catch (e) {
      alert(String(e));
    }
  }

  const runningByName = new Map(servers.map((s) => [s.name, s]));

  return (
    <div style={{ marginTop: 8 }}>
      <div className="agent-settings-row">
        <span className="agent-settings-label">MCP servers:</span>
        <span className="agent-settings-hint">
          External tool providers (stdio JSON-RPC). Spawn with full user privileges — only add commands you trust.
        </span>
      </div>
      {configs.length === 0 && (
        <div className="agent-settings-hint" style={{ padding: "4px 0 8px 0" }}>
          No MCP servers configured. Example: <code>npx -y @modelcontextprotocol/server-filesystem /tmp</code>
        </div>
      )}
      {configs.map((cfg) => {
        const live = runningByName.get(cfg.name);
        const status = live?.status ?? "stopped";
        const toolNames = tools[cfg.name] ?? [];
        return (
          <div
            key={cfg.name}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: 8,
              marginBottom: 8,
              background: "var(--surface)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <strong style={{ fontSize: 13 }}>{cfg.name}</strong>
              <span
                className={`agent-status-pill status-${status === "running" ? "tool" : "idle"}`}
                style={{ fontSize: 11 }}
              >
                {status}
              </span>
              <span className="agent-settings-hint" style={{ fontSize: 11 }}>
                {live ? `${live.tool_count} tools` : "not running"}
              </span>
              <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                {status === "running" ? (
                  <button className="agent-settings-btn" onClick={() => stopServer(cfg.name)}>Stop</button>
                ) : (
                  <button className="agent-settings-btn" onClick={() => startConfig(cfg)}>Start</button>
                )}
                <button className="agent-settings-btn" onClick={() => restartConfig(cfg)}>Restart</button>
                <button className="agent-settings-btn" onClick={() => showStderr(cfg.name)}>Stderr</button>
                <button className="agent-settings-btn" onClick={() => removeConfig(cfg.name)}>Remove</button>
              </div>
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", padding: "4px 0" }}>
              <code>{cfg.command}{cfg.args && cfg.args.length ? " " + cfg.args.join(" ") : ""}</code>
            </div>
            {live?.last_error && (
              <div className="error-bar" style={{ fontSize: 11 }}>
                {live.last_error}
              </div>
            )}
            {toolNames.length > 0 && (
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                tools: {toolNames.map((n) => `mcp__${cfg.name}__${n}`).join(", ")}
              </div>
            )}
          </div>
        );
      })}

      {!adding ? (
        <button className="agent-settings-btn" onClick={() => setAdding(true)}>+ Add MCP server</button>
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
            placeholder="name (letters, digits, _ or -)"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            style={inputStyle}
          />
          <input
            placeholder="command (e.g. npx)"
            value={draftCommand}
            onChange={(e) => setDraftCommand(e.target.value)}
            style={inputStyle}
          />
          <input
            placeholder="args (space-separated, e.g. -y @modelcontextprotocol/server-filesystem /tmp)"
            value={draftArgs}
            onChange={(e) => setDraftArgs(e.target.value)}
            style={inputStyle}
          />
          <input
            placeholder='env as JSON, e.g. {"FOO":"bar"}'
            value={draftEnv}
            onChange={(e) => setDraftEnv(e.target.value)}
            style={inputStyle}
          />
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            ⚠ This command runs with full user privileges. Only add servers you trust.
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <button className="agent-settings-btn" onClick={addServer}>Add & start</button>
            <button className="agent-settings-btn" onClick={() => { setAdding(false); setErr(null); }}>Cancel</button>
          </div>
        </div>
      )}

      {err && <div className="error-bar" style={{ marginTop: 8 }}>{err}</div>}
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
