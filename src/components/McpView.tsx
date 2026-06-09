import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/tauri-api";
import { logDiag } from "../lib/diagnostics";
import { useTwoClickConfirm } from "../lib/use-two-click-confirm";
import { Button, Input, Spinner, Badge } from "./ui";
import { EmptyState } from "./EmptyState";
import { Globe, Plug, Star, Check, X } from "lucide-react";
import type { McpServerConfig, McpServerInfo, McpRegistryEntry } from "../types";
import "../styles/mcp.css";

/* ── MCP Tools hub ──────────────────────────────────────────────────────
 * One surface to browse MCP server registries, install/connect servers
 * (local stdio packages OR remote streamable-HTTP endpoints), and manage the
 * running set (status, tools, start/stop/remove). Shares the `mcp.servers`
 * localStorage + settings.json persistence with the legacy Agent-Settings
 * panel so both stay in sync. Remote tokens live in the Keychain (Rust side).
 */

function loadConfigs(): McpServerConfig[] {
  try {
    const raw = localStorage.getItem("mcp.servers");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s) => s && typeof s === "object" && typeof s.name === "string");
  } catch (err) {
    logDiag({ level: "warn", source: "mcp", message: "loadConfigs malformed", detail: err });
    return [];
  }
}
function saveConfigs(list: McpServerConfig[]) {
  localStorage.setItem("mcp.servers", JSON.stringify(list));
  api.settingsSet({ mcp_servers: list }).catch((e) =>
    logDiag({ level: "warn", source: "mcp", message: "persist mcp_servers failed", detail: e }),
  );
}

/** Sanitize a registry id into a valid server name ([A-Za-z0-9_-]{1,64}). */
function deriveName(id: string): string {
  const tail = id.split("/").pop() ?? id;
  const cleaned = tail.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return (cleaned || "server").slice(0, 64);
}

/** Map a package entry to a stdio launch command, or null if unsupported. */
function packageLaunch(e: McpRegistryEntry): { command: string; args: string[] } | null {
  if (!e.package_name) return null;
  const reg = (e.package_registry ?? "").toLowerCase();
  if (reg.includes("npm")) return { command: "npx", args: ["-y", e.package_name] };
  if (reg.includes("pypi") || reg.includes("pip")) return { command: "uvx", args: [e.package_name] };
  return null;
}

export function McpView() {
  const [tab, setTab] = useState<"installed" | "browse">("installed");
  const [configs, setConfigs] = useState<McpServerConfig[]>(() => loadConfigs());
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [tools, setTools] = useState<Record<string, string[]>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const removeConfirm = useTwoClickConfirm();

  // Browse state
  const [source, setSource] = useState("official");
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<McpRegistryEntry[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  // Soft info banner (e.g. "fell back to PulseMCP") — distinct from the red err.
  const [note, setNote] = useState<string | null>(null);

  // Add form (manual / prefilled)
  const [form, setForm] = useState<{
    open: boolean;
    kind: "stdio" | "remote";
    name: string;
    command: string;
    args: string;
    env: string;
    url: string;
    token: string;
  } | null>(null);

  const statusByName = useMemo(() => {
    const m: Record<string, McpServerInfo> = {};
    for (const s of servers) m[s.name] = s;
    return m;
  }, [servers]);

  // Portal target in the App header — lets the tab bar + "Add manually" share
  // the theme-toggle's row instead of stacking a second bar below it.
  const [topbarSlot, setTopbarSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setTopbarSlot(document.getElementById("mcp-topbar-slot")), []);

  const refreshing = useRef(false);
  const refresh = useCallback(async () => {
    // Skip if a previous poll is still in flight — with several (or slow /
    // restarting) servers a refresh can exceed the 4s interval and overlap,
    // stacking N+1 IPC calls. Per-server tool fetches run in parallel.
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const raw = await api.mcpListServers();
      const list = Array.isArray(raw) ? raw : [];
      setServers(list);
      const pairs = await Promise.all(
        list.map(async (s) => {
          try {
            const ts = await api.mcpListTools(s.name);
            return [s.name, Array.isArray(ts) ? ts.map((t) => t.name) : []] as const;
          } catch {
            return [s.name, [] as string[]] as const; // mid-restart
          }
        }),
      );
      setTools(Object.fromEntries(pairs));
    } catch (e) {
      setErr(String(e));
    } finally {
      refreshing.current = false;
    }
  }, []);

  useEffect(() => {
    refresh();
    // Skip the 4s poll while the tab/window is hidden — no point hitting the
    // MCP servers when nobody's looking. Refresh immediately on regaining
    // visibility so the view is current. (Matches AgentToolbar's pattern.)
    const t = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 4000);
    const onVis = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refresh]);

  const loadBrowse = useCallback((src: string, q: string) => {
    setBrowseLoading(true);
    setNote(null);
    api
      .mcpRegistrySearch(src, q || undefined)
      .then((e) => {
        setEntries(e);
        setErr(null);
      })
      .catch(async (e) => {
        const msg = e instanceof Error ? e.message : String(e);
        // The official registry's /v0/servers route is intermittently slow/
        // hangs server-side — auto-fall back to PulseMCP so the user still gets
        // results instead of an empty error screen.
        if (src === "official") {
          try {
            const pulse = await api.mcpRegistrySearch("pulse", q || undefined);
            setEntries(pulse);
            setErr(null);
            setNote("Official registry didn't respond — showing PulseMCP results.");
            return;
          } catch {
            /* fall through to the original error */
          }
        }
        // Don't leave the previous source's cards showing under an error.
        setEntries([]);
        setErr(
          msg.includes("410")
            ? "PulseMCP is rate-limiting right now — try again in a minute, or use the Official registry."
            : msg,
        );
      })
      .finally(() => setBrowseLoading(false));
  }, []);

  useEffect(() => {
    if (tab !== "browse") return;
    const t = setTimeout(() => loadBrowse(source, query.trim()), 250);
    return () => clearTimeout(t);
  }, [tab, source, query, loadBrowse]);

  function persist(next: McpServerConfig[]) {
    setConfigs(next);
    saveConfigs(next);
  }

  const startConfig = useCallback(
    async (cfg: McpServerConfig) => {
      setBusy(cfg.name);
      setErr(null);
      try {
        if (cfg.url) {
          // Restart: token is in Keychain, no need to re-send.
          await api.mcpStartRemoteServer(cfg.name, cfg.url);
        } else {
          await api.mcpStartServer(cfg.name, cfg.command, cfg.args, cfg.env);
        }
        await refresh();
      } catch (e) {
        setErr(`Start '${cfg.name}': ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const stopServer = useCallback(
    async (name: string) => {
      setBusy(name);
      try {
        await api.mcpStopServer(name);
        await refresh();
      } catch (e) {
        setErr(String(e));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const removeConfig = useCallback(
    async (cfg: McpServerConfig) => {
      await api.mcpStopServer(cfg.name).catch(() => undefined);
      if (cfg.url) await api.mcpDeleteRemoteToken(cfg.name).catch(() => undefined);
      persist(configs.filter((c) => c.name !== cfg.name));
      await refresh();
    },
    [configs, refresh],
  );

  // Add a server from the manual/prefilled form.
  const submitForm = useCallback(async () => {
    if (!form) return;
    const name = deriveName(form.name.trim() || "server");
    if (configs.some((c) => c.name === name)) {
      setErr(`A server named '${name}' already exists.`);
      return;
    }
    setBusy(name);
    setErr(null);
    try {
      let cfg: McpServerConfig;
      if (form.kind === "remote") {
        if (!form.url.trim()) {
          setErr("Remote URL required.");
          setBusy(null);
          return;
        }
        await api.mcpStartRemoteServer(name, form.url.trim(), form.token || undefined);
        cfg = { name, command: "", url: form.url.trim(), enabled: true };
      } else {
        const args = form.args.trim() ? form.args.trim().split(/\s+/) : [];
        let env: Record<string, string> | undefined;
        if (form.env.trim()) {
          try {
            env = JSON.parse(form.env);
          } catch {
            setErr("Env must be a JSON object.");
            setBusy(null);
            return;
          }
        }
        await api.mcpStartServer(name, form.command.trim(), args, env);
        cfg = { name, command: form.command.trim(), args, env, enabled: true };
      }
      persist([...configs.filter((c) => c.name !== name), cfg]);
      setForm(null);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [form, configs, refresh]);

  // One-click OAuth: authorize a remote server in the browser — no API key.
  const submitOauth = useCallback(async () => {
    if (!form || form.kind !== "remote") return;
    const name = deriveName(form.name.trim() || "server");
    if (configs.some((c) => c.name === name)) {
      setErr(`A server named '${name}' already exists.`);
      return;
    }
    if (!form.url.trim()) {
      setErr("Remote URL required.");
      return;
    }
    setBusy(name);
    setErr(null);
    try {
      await api.mcpOauthConnect(name, form.url.trim());
      persist([...configs.filter((c) => c.name !== name), { name, command: "", url: form.url.trim(), enabled: true }]);
      setForm(null);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [form, configs, refresh]);

  // One-click add from a registry card.
  const addFromEntry = useCallback(
    (e: McpRegistryEntry) => {
      const name = deriveName(e.id);
      if (e.transport === "remote" && e.remote_url) {
        // Open the form so the user can paste a token if needed.
        setForm({ open: true, kind: "remote", name, command: "", args: "", env: "", url: e.remote_url, token: "" });
        setTab("installed");
        return;
      }
      const launch = packageLaunch(e);
      if (!launch) {
        setForm({ open: true, kind: "stdio", name, command: "", args: "", env: "", url: "", token: "" });
        setTab("installed");
        setErr("This server has no npm/pypi package — fill the command manually.");
        return;
      }
      setForm({
        open: true,
        kind: "stdio",
        name,
        command: launch.command,
        args: launch.args.join(" "),
        env: "",
        url: "",
        token: "",
      });
      setTab("installed");
    },
    [],
  );

  const tabBarInner = (
    <>
      <button role="tab" aria-selected={tab === "installed"} className={`mcp-tab${tab === "installed" ? " sel" : ""}`} onClick={() => { setErr(null); setTab("installed"); }}>
        Installed{configs.length ? ` (${configs.length})` : ""}
      </button>
      <button role="tab" aria-selected={tab === "browse"} className={`mcp-tab${tab === "browse" ? " sel" : ""}`} onClick={() => { setForm(null); setErr(null); setTab("browse"); }}>
        Browse
      </button>
      <div className="mcp-tabspacer" />
      {tab === "installed" && (
        <Button size="sm" variant="secondary" onClick={() => setForm({ open: true, kind: "stdio", name: "", command: "", args: "", env: "", url: "", token: "" })}>
          + Add manually
        </Button>
      )}
    </>
  );

  return (
    <div className="mcp-root" data-testid="mcp-view">
      {topbarSlot
        ? createPortal(<div className="mcp-tabs in-topbar" role="tablist">{tabBarInner}</div>, topbarSlot)
        : <div className="mcp-tabs" role="tablist">{tabBarInner}</div>}

      {err && (
        <div className="mcp-err" role="alert">
          {err}
          <button className="mcp-err-x" onClick={() => setErr(null)} aria-label="dismiss"><X size={16} /></button>
        </div>
      )}
      {note && !err && (
        <div className="mcp-note" role="status">
          {note}
          <button className="mcp-err-x" onClick={() => setNote(null)} aria-label="dismiss"><X size={16} /></button>
        </div>
      )}

      {/* Add / edit form */}
      {tab === "installed" && form?.open && (
        <div className="mcp-form">
          <div className="mcp-form-row">
            <label className="mcp-kind">
              <input type="radio" checked={form.kind === "stdio"} onChange={() => setForm({ ...form, kind: "stdio" })} /> Local (stdio)
            </label>
            <label className="mcp-kind">
              <input type="radio" checked={form.kind === "remote"} onChange={() => setForm({ ...form, kind: "remote" })} /> Remote (URL)
            </label>
          </div>
          <Input placeholder="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          {form.kind === "remote" ? (
            <>
              <Input placeholder="https://…/mcp endpoint URL" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
              <Input type="password" placeholder="bearer token (optional — or use Connect with browser)" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} />
            </>
          ) : (
            <>
              <Input placeholder="command (e.g. npx)" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} />
              <Input placeholder="args (space-separated, e.g. -y @modelcontextprotocol/server-filesystem ~/dir)" value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} />
              <Input placeholder='env JSON (optional, e.g. {"API_KEY":"…"})' value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })} />
            </>
          )}
          {form.kind === "stdio" && (
            <div className="mcp-warn">⚠ Local servers run as programs with your full user privileges. Only add commands you trust.</div>
          )}
          <div className="mcp-form-actions">
            <Button size="sm" variant="primary" onClick={() => void submitForm()} disabled={busy !== null}>
              {busy ? <Spinner label="Connecting" /> : "Connect"}
            </Button>
            {form.kind === "remote" && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void submitOauth()}
                disabled={busy !== null}
                title="Authorize in your browser — no API key needed (if the server supports OAuth)"
              >
                {busy ? <Spinner label="Authorizing" /> : <><Globe size={16} /> Connect with browser</>}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
          </div>
        </div>
      )}

      {tab === "installed" ? (
        <div className="mcp-list">
          {configs.length === 0 && !form && (
            <EmptyState
              icon={<Plug size={24} />}
              heading="No MCP servers yet"
              cta={<button className="mcp-link" onClick={() => setTab("browse")}>Browse the registry →</button>}
            />
          )}
          {configs.map((cfg) => {
            const info = statusByName[cfg.name];
            const status = info?.status ?? "stopped";
            const running = status === "running";
            const toolNames = tools[cfg.name] ?? [];
            return (
              <div className="mcp-item" key={cfg.name}>
                <div className="mcp-item-head">
                  <span className={`mcp-dot ${status}`} />
                  <span className="mcp-item-name">{cfg.name}</span>
                  <Badge tone={cfg.url ? "accent" : "neutral"}>{cfg.url ? "remote" : "stdio"}</Badge>
                  {running && <span className="mcp-toolcount">{toolNames.length} tools</span>}
                  <div className="mcp-tabspacer" />
                  {running ? (
                    <Button size="sm" variant="ghost" onClick={() => void stopServer(cfg.name)} disabled={busy === cfg.name}>Stop</Button>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => void startConfig(cfg)} disabled={busy === cfg.name} aria-busy={busy === cfg.name}>
                      {busy === cfg.name ? <Spinner label="Starting" /> : "Start"}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant={removeConfirm.armed === cfg.name ? "danger" : "ghost"}
                    disabled={busy === cfg.name}
                    onClick={() => removeConfirm.request(cfg.name, () => void removeConfig(cfg))}
                  >
                    {removeConfirm.labelFor(cfg.name, "Remove")}
                  </Button>
                </div>
                <div className="mcp-item-sub" title={cfg.url ?? `${cfg.command} ${(cfg.args ?? []).join(" ")}`}>
                  {cfg.url ?? `${cfg.command} ${(cfg.args ?? []).join(" ")}`}
                </div>
                {info?.last_error && <div className="mcp-item-err">{info.last_error}</div>}
                {running && toolNames.length > 0 && (
                  <div className="mcp-toolchips">
                    {toolNames.slice(0, 12).map((t) => <span className="mcp-toolchip" key={t}>{t}</span>)}
                    {toolNames.length > 12 && <span className="mcp-toolchip">+{toolNames.length - 12}</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mcp-browse">
          <div className="mcp-browse-bar">
            <div className="mcp-src">
              {["official", "pulse"].map((s) => (
                <button key={s} className={`mcp-srcbtn${source === s ? " sel" : ""}`} onClick={() => setSource(s)}>
                  {s === "official" ? "Official registry" : "PulseMCP"}
                </button>
              ))}
            </div>
            <Input placeholder="Search MCP servers…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          {browseLoading && entries.length === 0 ? (
            <div className="skeleton-list" aria-busy="true" aria-label="Loading registry">
              <div className="skeleton-row" />
              <div className="skeleton-row" />
              <div className="skeleton-row" />
              <div className="skeleton-row" />
            </div>
          ) : (
            <div className="mcp-cards">
              {entries.slice(0, 60).map((e) => {
                const installed = configs.some((c) => c.name === deriveName(e.id));
                const launch = e.transport === "package" ? packageLaunch(e) : null;
                const canAdd = e.transport === "remote" || launch !== null;
                return (
                  <div className="mcp-card" key={`${e.source}:${e.id}`}>
                    <div className="mcp-card-head">
                      <span className="mcp-card-name" title={e.id}>{e.title || e.name}</span>
                      <Badge tone={e.transport === "remote" ? "accent" : e.transport === "package" ? "neutral" : "warn"}>{e.transport}</Badge>
                    </div>
                    <div className="mcp-card-desc">{e.description}</div>
                    <div className="mcp-card-foot">
                      <span className="mcp-card-meta">
                        {e.stars != null && <span title="GitHub stars"><Star size={12} /> {e.stars}</span>}
                        {e.package_registry && <span className="mcp-card-pkg">{e.package_registry}</span>}
                      </span>
                      {installed ? (
                        <Button size="sm" variant="ghost" disabled>Added <Check size={14} /></Button>
                      ) : canAdd ? (
                        <Button size="sm" variant="primary" onClick={() => addFromEntry(e)}>Add</Button>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => e.homepage && void api.openExternal(e.homepage)} disabled={!e.homepage}>Open ↗</Button>
                      )}
                    </div>
                  </div>
                );
              })}
              {!browseLoading && entries.length === 0 && <div className="mcp-empty">No servers found.</div>}
              {entries.length > 60 && (
                <div className="mcp-empty">Showing 60 of {entries.length} — refine your search to narrow.</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
